"""
import_parser.py
===============
Parses the GHW Plecto production tracker spreadsheet.

The file layout has been verified (Running sheet, sheet_name=0):

  Row 0   — headers. Col 0 has no header (the agent email column).
            Col 1 = " Agent" (leading space), Col 2 = Client,
            Col 3 = Carrier, Col 4 = Product, Col 5 = Premium,
            Col 6 = Revenue, Col 7 = App Date, Col 8 = Effective Date,
            Col 11 = New Client (Y/N), Col 12 = Lead Source.
  Row 1+  — data rows.

Because the layout is fixed and well-known we map columns directly by
position rather than fuzzy-matching header text. Earlier versions of this
file tried to detect headers and that proved fragile against the real
spreadsheet (leading spaces, blank email header, no mid-file re-headers).
"""
import hashlib
import io
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


# ── Product type normalization ────────────────────────
PRODUCT_MAP = {
    "med supp": "Medicare Supplement",
    "medical supplement": "Medicare Supplement",
    "medicare supplement": "Medicare Supplement",
    "ma": "Medicare Advantage",
    "medicare advantage": "Medicare Advantage",
    "pdp": "Prescription Drug Plan",
    "prescription drug plan": "Prescription Drug Plan",
    "cancer": "Cancer",
    "h&s": "Heart/Stroke",
    "h\\&s": "Heart/Stroke",
    "heart/stroke": "Heart/Stroke",
    "heart stroke": "Heart/Stroke",
    "hs": "Heart/Stroke",
    "hip": "Hospital Indemnity",
    "hospital indemnity": "Hospital Indemnity",
    "recovery": "Recovery Care",
    "recovey care": "Recovery Care",
    "recovery care": "Recovery Care",
    "rc": "Recovery Care",
    "dvh": "Dental Vision Hearing",
    "dental vision hearing": "Dental Vision Hearing",
    "dental/vision/hearing": "Dental Vision Hearing",
    "life": "Life",
    "final expense": "Life",
    "fe": "Life",
    "fia": "Annuity",
    "annuity": "Annuity",
    "chs": "Cancer",
    "ihp": "Hospital Indemnity",
    "ihp ": "Hospital Indemnity",
}

# Rows with these product types are skipped (out of scope)
SKIP_PRODUCTS = {"ihp", "iph"}

# Agent email overrides (Leadership maps to Chase)
AGENT_EMAIL_MAP = {
    "leadership": "cgruening@grueninghealthwealth.com",
    "agency pt": "cgruening@grueninghealthwealth.com",
}


def clean_premium(val: Any) -> Optional[float]:
    """Remove $, commas, handle blank/None → None."""
    if val is None:
        return None
    s = str(val).strip().replace("$", "").replace(",", "").replace(" ", "")
    if not s or s in ("-", "N/A", "n/a", ""):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_product(val: Any) -> Optional[str]:
    """Map all product name variants to canonical form."""
    if not val:
        return None
    key = str(val).strip().lower()
    return PRODUCT_MAP.get(key)


def parse_date(val: Any) -> Optional[str]:
    """Handle multiple date formats → YYYY-MM-DD."""
    if val is None:
        return None
    s = str(val).strip()
    if not s or s in ("", "N/A", "n/a"):
        return None
    # pandas reads Excel datetimes as "2025-01-02 00:00:00". Drop the time
    # half so the ISO regex below catches the date part.
    if " " in s and ":" in s:
        s = s.split(" ")[0]
    # Already ISO format
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        # Validate it's a real date
        try:
            datetime.strptime(s, "%Y-%m-%d")
            # Filter out garbage dates
            if s.startswith("0205") or s < "2020-01-01":
                return None
            return s
        except ValueError:
            return None
    # M/D/YYYY or MM/DD/YYYY. Python's strptime is lenient about leading zeros
    # so "%m/%d/%Y" already accepts "1/2/2025". The "%-m/%-d/%Y" alias is kept
    # for Unix users who may copy this code; on Windows it's a noop (silently
    # fails through to the next pattern). Two-digit year fallback last.
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%m/%d/%y"):
        try:
            d = datetime.strptime(s, fmt)
            if d.year < 2020 or d.year > 2030:
                return None
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def make_dedup_key(agent_email: str, client_name: str,
                   carrier: str, product_type: str,
                   app_date: Optional[str]) -> str:
    """SHA256 dedup key — same record imported twice = skipped."""
    payload = f"{agent_email}|{client_name}|{carrier}|{product_type}|{app_date or ''}"
    return hashlib.sha256(payload.lower().encode()).hexdigest()[:32]


def is_valid_production_row(row: Dict) -> Tuple[bool, str]:
    """Returns (valid, reason_if_invalid)."""
    if not row.get("agent_email"):
        return False, "Missing agent email"
    if not row.get("client_name"):
        return False, "Missing client name"
    if not row.get("carrier"):
        return False, "Missing carrier"
    if not row.get("product_type"):
        return False, f"Unknown product type: {row.get('raw_product', '')}"
    if not row.get("app_date") and not row.get("effective_date"):
        return False, "Missing both app date and effective date"
    return True, ""


def parse_production_file(file_bytes: bytes, filename: str) -> Dict:
    """Parse the GHW production tracker XLSX or CSV file.

    Returns:
      {
        rows: [normalized row dicts],
        errors: [{row_num, raw, reason}],
        agents: {email: name},
        total_raw: int,
      }

    Column mapping is direct/positional — the layout is fixed in the GHW
    spreadsheet and was previously failing because fuzzy header detection
    couldn't deal with the headerless email column at index 0.
    """
    # Lazy import — keeps the helper-only entry points (clean_premium,
    # normalize_product, parse_date) usable without pandas installed,
    # so the verification command works in slim environments.
    import pandas as pd

    rows: List[Dict] = []
    errors: List[Dict] = []
    agents_seen: Dict[str, str] = {}

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(
                io.BytesIO(file_bytes),
                header=None,
                dtype=str,
            )
        else:
            df = pd.read_excel(
                io.BytesIO(file_bytes),
                header=None,
                dtype=str,
                sheet_name=0,
            )
    except Exception as e:
        return {
            "rows": [],
            "errors": [{"row_num": 0, "raw": "",
                         "reason": f"File error: {e}"}],
            "agents": {},
            "total_raw": 0,
        }

    df = df.fillna("")
    total_raw = len(df)

    # FIXED COLUMN MAP — direct positional mapping:
    #   0 = email, 1 = agent, 2 = client, 3 = carrier, 4 = product,
    #   5 = premium, 6 = revenue, 7 = app_date, 8 = effective_date,
    #   11 = new_client, 12 = lead_source, 14 = cancel (some sections)
    # Skip row 0 — it's the header row.

    for row_num in range(1, len(df)):
        row = df.iloc[row_num]

        def g(idx: int, default: str = "") -> str:
            try:
                v = row.iloc[idx]
                return str(v).strip() if v else default
            except Exception:
                return default

        raw_email = g(0)

        # Must have a valid email to be a production row
        if not ("@" in raw_email and "." in raw_email.split("@")[-1]):
            continue

        # Normalize Leadership / Agency PT to Chase's email. Match either
        # the email field or the agent-name field on substring (the real
        # data has "Leadership" both as a name and embedded in some emails).
        raw_agent = g(1)
        email_lower = raw_email.lower()
        agent_lower = raw_agent.lower().strip()
        for alias, real_email in AGENT_EMAIL_MAP.items():
            if alias in email_lower or alias in agent_lower:
                raw_email = real_email
                break

        raw_client = g(2)
        raw_carrier = g(3)
        raw_product = g(4)

        # Skip rows without carrier or product (coaching/membership rows)
        if not raw_carrier or not raw_product:
            continue

        # Skip FIA/annuity (different calc, out of scope)
        if raw_product.strip().lower() == "fia":
            continue

        # Skip IHP / IPH (out of scope)
        if raw_product.strip().lower() in ("ihp", "iph"):
            continue

        product_type = normalize_product(raw_product)

        raw_premium = g(5)
        raw_revenue = g(6)
        raw_app_date = g(7)
        raw_eff_date = g(8)
        raw_new = g(11)
        raw_source = g(12)
        # Some sections add a Cancel column at index 14; safe-default when absent.
        raw_cancel = g(14)

        monthly_premium = clean_premium(raw_premium)
        revenue = clean_premium(raw_revenue)
        app_date = parse_date(raw_app_date)
        effective_date = parse_date(raw_eff_date)

        new_client = str(raw_new).strip().lower() in (
            "y", "yes", "true", "1")
        is_cancel = bool(
            raw_cancel and str(raw_cancel).strip() not in ("", "0"))

        normalized = {
            "agent_email": raw_email.lower().strip(),
            "agent_name": raw_agent.strip(),
            "client_name": raw_client,
            "carrier": raw_carrier,
            "raw_product": raw_product,
            "product_type": product_type,
            "monthly_premium": monthly_premium,
            "annual_premium": (
                round(monthly_premium * 12, 2)
                if monthly_premium else None
            ),
            "revenue_expected": revenue,
            "app_date": app_date,
            "effective_date": effective_date,
            "lead_source": raw_source or None,
            "new_client": new_client,
            "is_cancel": is_cancel,
            "dedup_key": make_dedup_key(
                raw_email, raw_client, raw_carrier,
                product_type or raw_product, app_date),
        }

        valid, reason = is_valid_production_row(normalized)
        if valid:
            rows.append(normalized)
            agents_seen[raw_email.lower().strip()] = raw_agent.strip()
        else:
            errors.append({
                "row_num": row_num + 1,
                "raw": f"{raw_agent} | {raw_client} | {raw_carrier} | {raw_product}",
                "reason": reason,
            })

    return {
        "rows": rows,
        "errors": errors,
        "agents": agents_seen,
        "total_raw": total_raw,
    }
