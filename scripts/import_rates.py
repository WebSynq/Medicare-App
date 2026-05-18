#!/usr/bin/env python3
"""
import_rates.py
================
Seed the carrier_rates collection with the GHW commission schedule.

Usage:
    python scripts/import_rates.py

Env vars:
    MONGO_URL  (required)
    DB_NAME    (required)

The rate document model:

    {
      "natural_key":      "<sha256(carrier|product|effective_year)>",
      "carrier":          "Aetna",
      "product":          "Cancer/H&S",
      "rate_type":        "percent" | "flat",
      "default_rate":     0.675   # decimal, only set for rate_type=percent
      "default_pct":      67.5    # human-readable, percentage form
      "flat_amount":      313.0   # only set for rate_type=flat
      "currency":         "USD"   # flat rates only
      "state_overrides":  { "AZ": 0.62, "FL": 0.62 }    # state → decimal
      "issue_age_range":  "65-79"                       # optional metadata
      "effective_year":   2025                          # year this row applies to
      "notes":            "..."
      "imported_at":      "<iso8601>"
      "updated_at":       "<iso8601>"
    }

Idempotency: upsert keyed on (carrier, product, effective_year) via a
SHA-256 natural_key. Re-running the script overwrites the same rows in
place — no duplicates.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


logging.basicConfig(level=logging.INFO,
                     format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("import_rates")


# ── Helpers ────────────────────────────────────────────────────────────────
def pct(value_percent: float) -> float:
    """Convert a percentage figure to a decimal multiplier (67.5 → 0.675)."""
    return round(value_percent / 100.0, 6)


def percent_rate(
    carrier: str,
    product: str,
    default_pct: float,
    state_overrides: Optional[dict[str, float]] = None,
    effective_year: int = 2025,
    issue_age_range: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    return {
        "carrier": carrier,
        "product": product,
        "rate_type": "percent",
        "default_rate": pct(default_pct),
        "default_pct": default_pct,
        "flat_amount": None,
        "currency": None,
        "state_overrides": {k.upper(): pct(v) for k, v in (state_overrides or {}).items()},
        "issue_age_range": issue_age_range,
        "effective_year": effective_year,
        "notes": notes,
    }


def flat_rate(
    carrier: str,
    product: str,
    flat_amount: float,
    effective_year: int = 2025,
    notes: Optional[str] = None,
) -> dict:
    return {
        "carrier": carrier,
        "product": product,
        "rate_type": "flat",
        "default_rate": None,
        "default_pct": None,
        "flat_amount": flat_amount,
        "currency": "USD",
        "state_overrides": {},
        "issue_age_range": None,
        "effective_year": effective_year,
        "notes": notes,
    }


def _natural_key(carrier: str, product: str, effective_year: int) -> str:
    parts = [carrier.strip().lower(), product.strip().lower(), str(effective_year)]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


# ── Rate schedule ──────────────────────────────────────────────────────────
# Source: GHW commission schedule, confirmed by Leadership.
# Reduced-rate state lists are inline; expand as documented overrides arrive.
RATES: list[dict] = [
    # ── Aetna percent products ──
    percent_rate("Aetna", "Cancer/H&S", 67.50,
                 state_overrides={"AZ": 62.00, "FL": 62.00},
                 notes="67.5% most states; 62% in reduced-rate states (AZ/FL/etc)"),
    percent_rate("Aetna", "HIP", 67.50,
                 state_overrides={"AZ": 62.00, "FL": 62.00},
                 notes="67.5% most states; 62% in select reduced-rate states"),
    percent_rate("Aetna", "Recovery Care", 67.50,
                 notes="67.5% most states"),
    percent_rate("Aetna", "DVH", 59.00,
                 notes="59% most states"),

    # ── Aetna Med Supp ──
    # Plan N issue ages 65-79: range 27-40% by state — using the midpoint
    # as default with notes documenting the spread; admins can refine
    # per-state when AgencyBloc reconciliation surfaces the actual rates.
    percent_rate("Aetna", "Med Supp Plan N", 33.50,
                 issue_age_range="65-79",
                 notes="State-dependent 27-40%. Default 33.5% (midpoint); "
                       "override per state as confirmed."),
    percent_rate("Aetna", "Med Supp Plan G", 27.00,
                 issue_age_range="65-79",
                 notes="27% most states"),
    percent_rate("Aetna", "Med Supp Plan F", 27.00,
                 issue_age_range="65-79",
                 notes="27% most states"),

    # ── GTL ──
    percent_rate("GTL", "Recovery/CHS", 85.00,
                 notes="85% most states"),

    # ── Liberty Bankers ──
    percent_rate("Liberty Bankers", "HIP", 82.50,
                 notes="82.5% most states"),

    # ── Mutual of Omaha ──
    percent_rate("Mutual of Omaha", "Med Supp", 24.00,
                 notes="24% most states"),
    percent_rate("Mutual of Omaha", "DVH", 52.00,
                 notes="52% most states"),

    # ── Cigna ──
    percent_rate("Cigna", "Med Supp", 24.00,
                 notes="24% most states"),

    # ── MA flat (carrier-agnostic per current GHW schedule) ──
    # Two effective years on file — 2025 (pre-2026) and 2026 — so the
    # commission engine can pick the right row based on effective_date.
    flat_rate("Any MA Carrier", "MA — Single Enrollment", 313.0,
              effective_year=2025,
              notes="Pre-2026 single-enrollment MA commission"),
    flat_rate("Any MA Carrier", "MA — Couple/Dual", 626.0,
              effective_year=2025,
              notes="Pre-2026 couple/dual MA commission"),
    flat_rate("Any MA Carrier", "MA — Single Enrollment", 694.0,
              effective_year=2026,
              notes="2026 MA single-enrollment commission"),
    flat_rate("Any MA Carrier", "MA — Couple/Dual", 694.0,
              effective_year=2026,
              notes="2026 MA couple/dual commission"),

    # ── PDP flat ──
    flat_rate("Any PDP Carrier", "PDP", 100.0,
              effective_year=2025,
              notes="$100 flat any carrier"),
    flat_rate("Any PDP Carrier", "PDP", 100.0,
              effective_year=2026,
              notes="$100 flat any carrier"),
]


# ── Main ────────────────────────────────────────────────────────────────────
async def _seed() -> dict:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit("MONGO_URL and DB_NAME env vars are required.")

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    coll = db.carrier_rates

    await coll.create_index("natural_key", unique=True)
    await coll.create_index("carrier")
    await coll.create_index("effective_year")

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    updated = 0

    for rate in RATES:
        key = _natural_key(rate["carrier"], rate["product"], rate["effective_year"])
        result = await coll.update_one(
            {"natural_key": key},
            {
                "$set": {
                    # Rate values may be re-tuned by Leadership; refresh on re-run.
                    "rate_type": rate["rate_type"],
                    "default_rate": rate["default_rate"],
                    "default_pct": rate["default_pct"],
                    "flat_amount": rate["flat_amount"],
                    "currency": rate["currency"],
                    "state_overrides": rate["state_overrides"],
                    "issue_age_range": rate["issue_age_range"],
                    "notes": rate["notes"],
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "natural_key": key,
                    "carrier": rate["carrier"],
                    "product": rate["product"],
                    "effective_year": rate["effective_year"],
                    "imported_at": now,
                },
            },
            upsert=True,
        )
        if result.upserted_id is not None:
            inserted += 1
        elif result.modified_count:
            updated += 1

    client.close()
    return {"total": len(RATES), "inserted": inserted, "updated": updated}


def main() -> None:
    stats = asyncio.run(_seed())
    logger.info("Rates seed done: total=%d inserted=%d updated=%d",
                stats["total"], stats["inserted"], stats["updated"])


if __name__ == "__main__":
    main()
