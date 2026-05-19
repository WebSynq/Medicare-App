"""
import_parser.py
===============
Parses the GHW Plecto production tracker spreadsheet.
Handles messy real-world data: mixed premium formats,
date variations, product name inconsistencies,
multiple table sections in one file.
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


def _is_header_row(row_vals: List) -> bool:
    """Detect header rows by checking for known column names."""
    row_str = " ".join(str(v).lower() for v in row_vals if v)
    return any(kw in row_str for kw in [
        "agent", "carrier", "product", "premium", "revenue",
        "app date", "effective date", "email",
    ])


def _looks_like_email(val: Any) -> bool:
    if not val:
        return False
    s = str(val)
    return "@" in s and "." in s.split("@")[-1]


def parse_production_file(file_bytes: bytes,
                          filename: str) -> Dict:
    """Parse a GHW production tracker XLSX or CSV file.

    Returns:
      {
        rows: [normalized row dicts],
        errors: [{row_num, raw, reason}],
        agents: {email: name},
        total_raw: int,
      }
    """
    # Lazy import — keeps the helper-only entry points (clean_premium,
    # normalize_product, parse_date) usable without pandas installed,
    # so the verification command works in slim environments.
    import pandas as pd

    rows: List[Dict] = []
    errors: List[Dict] = []
    agents_seen: Dict[str, str] = {}

    # Load file
    try:
        if filename.lower().endswith(".csv"):
            df_raw = pd.read_csv(
                io.BytesIO(file_bytes),
                header=None,
                dtype=str,
            )
        else:
            df_raw = pd.read_excel(
                io.BytesIO(file_bytes),
                header=None,
                dtype=str,
                sheet_name=0,
            )
    except Exception as e:
        return {
            "rows": [],
            "errors": [{"row_num": 0, "raw": "",
                         "reason": f"File parse error: {e}"}],
            "agents": {},
            "total_raw": 0,
        }

    # Fill NaN with empty string so downstream str() calls don't produce "nan"
    df_raw = df_raw.fillna("")

    total_raw = len(df_raw)
    current_headers = None
    col_idx: Dict[str, int] = {}

    for row_num, row in df_raw.iterrows():
        vals = list(row.values)

        # Detect header rows. The tracker has multiple stacked tables, each
        # with its own header — we rebuild col_idx every time we see one.
        if _is_header_row(vals):
            current_headers = [str(v).strip().lower() for v in vals]
            col_idx = {}
            for i, h in enumerate(current_headers):
                if "email" in h:
                    col_idx["email"] = i
                elif h == "agent" or h == "agent name":
                    col_idx["agent"] = i
                elif "client" in h:
                    col_idx["client"] = i
                elif "carrier" in h:
                    col_idx["carrier"] = i
                elif "product" in h:
                    col_idx["product"] = i
                elif "premium" in h and "monthly" not in h:
                    col_idx.setdefault("premium", i)
                elif "revenue" in h:
                    col_idx["revenue"] = i
                elif "app date" in h or ("app" in h and "date" in h):
                    col_idx["app_date"] = i
                elif "effective" in h and "date" in h:
                    col_idx["effective_date"] = i
                elif "lead source" in h or "source" in h:
                    col_idx.setdefault("lead_source", i)
                elif "new client" in h:
                    col_idx["new_client"] = i
                elif "cancel" in h:
                    col_idx["cancel"] = i
            continue

        if not col_idx:
            continue

        def g(key: str, default: str = "") -> str:
            idx = col_idx.get(key)
            if idx is None or idx >= len(vals):
                return default
            return str(vals[idx]).strip()

        raw_email = g("email")
        raw_agent = g("agent")

        # Normalize Leadership / Agency PT → Chase's email
        email_lower = raw_email.lower()
        if email_lower in AGENT_EMAIL_MAP:
            raw_email = AGENT_EMAIL_MAP[email_lower]
        agent_lower = raw_agent.lower()
        if agent_lower in AGENT_EMAIL_MAP:
            raw_email = AGENT_EMAIL_MAP[agent_lower]

        # Must have a valid email to be a production row
        if not _looks_like_email(raw_email):
            continue

        raw_product = g("product")
        product_type = normalize_product(raw_product)

        # Skip out-of-scope products
        if raw_product.strip().lower() in SKIP_PRODUCTS:
            continue

        # Skip coaching/membership rows (no carrier)
        raw_carrier = g("carrier")
        if not raw_carrier:
            continue

        # Skip FIA rows for now (different calc)
        if raw_product.strip().lower() == "fia":
            continue

        raw_client = g("client")
        raw_premium = g("premium")
        raw_revenue = g("revenue")
        raw_app_date = g("app_date")
        raw_eff_date = g("effective_date")
        raw_source = g("lead_source")
        raw_new = g("new_client")
        raw_cancel = g("cancel")

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
            "client_name": raw_client.strip(),
            "carrier": raw_carrier.strip(),
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
                "row_num": int(row_num) + 1,
                "raw": f"{raw_agent} | {raw_client} | {raw_carrier} | {raw_product}",
                "reason": reason,
            })

    return {
        "rows": rows,
        "errors": errors,
        "agents": agents_seen,
        "total_raw": total_raw,
    }
