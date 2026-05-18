#!/usr/bin/env python3
"""
seed_production_sample.py
=========================
One-time seed script: insert 5 hardcoded sample production_records so the
audit / leaderboard / chat endpoints have something to render before Matt
provides the real Plecto tracker (ROOKIE_SEASON_DOC.xlsx).

Idempotent — shares the same natural_key formula as import_production.py
(sha256 of carrier|policy_number|effective_date|agent_email), so:
- Re-running the seeder is safe (rows update in place, nothing duplicates).
- Re-running with the real .xlsx after this is safe — these 5 rows will
  upsert against the real data if their natural keys ever collide, and
  otherwise sit alongside it.

Records:
- 5 different agents from the confirmed 19-agent map
- 5 different carriers — Aetna, Mutual of Omaha, Liberty Bankers, GTL,
  and a flat-rate MA enrollment
- Revenue figures derived from the carrier_rates schedule (the same
  schedule scripts/import_rates.py seeds) — see _expected_pct/_expected_flat
- revenue_received: None       (AgencyBloc sync hasn't run)
- audit_status:    "pending"   (no human review yet)

Usage:
    MONGO_URL=mongodb+srv://... DB_NAME=ghw_medicare \\
        python scripts/seed_production_sample.py

Env vars:
    MONGO_URL  (required)
    DB_NAME    (required)
"""
import asyncio
import hashlib
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Reuse the same Mongo client + path setup as the other import scripts.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


logging.basicConfig(level=logging.INFO,
                     format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("seed_production_sample")


def _expected_pct(premium_monthly: float, pct: float) -> float:
    """Annualised commission for a percent-of-premium product."""
    return round(premium_monthly * 12 * pct, 2)


def _expected_flat(amount: float) -> float:
    return float(amount)


def _natural_key(carrier: str, policy_number: str,
                  effective_date: str, agent_email: str) -> str:
    """Identical formula to import_production.py — keep these two in lockstep
    or the upsert will silently mis-match between the seeder and the real
    import."""
    parts = [
        (carrier or "").strip().lower(),
        (policy_number or "").strip().lower(),
        (effective_date or "").strip().lower(),
        (agent_email or "").strip().lower(),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


# ── 5 sample records ────────────────────────────────────────────────────────
# Premium amounts and commission rates are tied to the GHW rate schedule
# seeded by scripts/import_rates.py — re-derive revenue_expected from
# premium so the test data is internally consistent and the audit endpoints
# show realistic gaps when we wire AgencyBloc data later.

SAMPLES = [
    {
        "agent_email": "wlunt@grueninghw.com",
        "agent_name":  "Wes Lunt",
        "carrier":     "Aetna",
        "product":     "Cancer/H&S",
        "state":       "IL",
        "policy_number":   "AETNA-CHS-2025-001",
        "client_name":     "Margaret Pearson",
        "effective_date":  "2025-04-01",
        "submitted_date":  "2025-03-28",
        "premium_monthly": 125.00,
        "revenue_expected": _expected_pct(125.00, 0.675),  # 67.5% IL — 1012.50
    },
    {
        "agent_email": "tgoveia@grueninghw.com",
        "agent_name":  "Travis Goveia",
        "carrier":     "Mutual of Omaha",
        "product":     "Med Supp",
        "state":       "TX",
        "policy_number":   "MOO-MS-2025-014",
        "client_name":     "Howard Bennett",
        "effective_date":  "2025-04-10",
        "submitted_date":  "2025-04-02",
        "premium_monthly": 142.50,
        "revenue_expected": _expected_pct(142.50, 0.24),  # 24% — 410.40
    },
    {
        "agent_email": "bryce@grueninghw.com",
        "agent_name":  "Bryce Pritchard",
        "carrier":     "Liberty Bankers",
        "product":     "HIP",
        "state":       "FL",
        "policy_number":   "LB-HIP-2025-007",
        "client_name":     "Eleanor Whitfield",
        "effective_date":  "2025-04-15",
        "submitted_date":  "2025-04-08",
        "premium_monthly": 198.75,
        "revenue_expected": _expected_pct(198.75, 0.825),  # 82.5% — 1967.63
    },
    {
        "agent_email": "kyle@grueninghw.com",
        "agent_name":  "Kyle Welch",
        "carrier":     "Any MA Carrier",
        "product":     "MA — Single Enrollment",
        "state":       "IL",
        "policy_number":   "MAPD-WELL-2025-003",
        "client_name":     "Frank Delgado",
        "effective_date":  "2025-05-01",
        "submitted_date":  "2025-04-22",
        "premium_monthly": 0.00,                              # MAPD often $0 premium
        "revenue_expected": _expected_flat(313.00),           # 2025 single-enrollment flat
    },
    {
        "agent_email": "matt@grueninghw.com",
        "agent_name":  "Matt Monacelli",
        "carrier":     "GTL",
        "product":     "Recovery/CHS",
        "state":       "AZ",
        "policy_number":   "GTL-CHS-2025-021",
        "client_name":     "Linda Carrasco",
        "effective_date":  "2025-05-05",
        "submitted_date":  "2025-04-30",
        "premium_monthly": 89.00,
        "revenue_expected": _expected_pct(89.00, 0.85),  # 85% — 907.80
    },
]


async def _seed() -> dict:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. "
            "Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\\n"
            "        python scripts/seed_production_sample.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    coll = db.production_records

    # Mirror import_production.py's index list — startup hooks also create
    # these, but a one-off seeder shouldn't depend on the server having
    # been started against this DB yet.
    await coll.create_index("natural_key", unique=True)
    await coll.create_index("agent_email")
    await coll.create_index("agent_name")
    await coll.create_index("effective_date")
    await coll.create_index("audit_status")

    now_iso = datetime.now(timezone.utc).isoformat()
    inserted = 0
    updated = 0

    for sample in SAMPLES:
        natural_key = _natural_key(
            sample["carrier"], sample["policy_number"],
            sample["effective_date"], sample["agent_email"],
        )
        premium_monthly = sample["premium_monthly"]
        premium_annual = round(premium_monthly * 12, 2)

        result = await coll.update_one(
            {"natural_key": natural_key},
            {
                # Refreshable fields — overwrite if the seed list changes.
                "$set": {
                    "agent_email": sample["agent_email"].lower(),
                    "agent_name": sample["agent_name"],
                    "client_name": sample["client_name"],
                    "product": sample["product"],
                    "state": sample["state"].upper(),
                    "submitted_date": sample["submitted_date"],
                    "premium_monthly": premium_monthly,
                    "premium_annual": premium_annual,
                    "revenue_expected": sample["revenue_expected"],
                    "ab_synced": False,
                    "updated_at": now_iso,
                },
                # Set-once — these become the row's identity once committed,
                # and revenue_received / audit_status are owned by later
                # workflow stages (AgencyBloc sync, admin resolve).
                "$setOnInsert": {
                    "natural_key": natural_key,
                    "policy_number": sample["policy_number"],
                    "carrier": sample["carrier"],
                    "effective_date": sample["effective_date"],
                    "revenue_received": None,
                    "audit_status": "pending",
                    "audit_notes": None,
                    "imported_at": now_iso,
                    "source": "seed_production_sample",
                },
            },
            upsert=True,
        )
        if result.upserted_id is not None:
            inserted += 1
            logger.info("Inserted: %s %s (%s) — expected $%.2f",
                         sample["agent_name"], sample["carrier"],
                         sample["policy_number"], sample["revenue_expected"])
        elif result.modified_count:
            updated += 1
            logger.info("Updated:  %s %s (%s)",
                         sample["agent_name"], sample["carrier"],
                         sample["policy_number"])
        else:
            logger.info("No change: %s %s (%s)",
                         sample["agent_name"], sample["carrier"],
                         sample["policy_number"])

    # Quick sanity readback so the operator can see the result without
    # opening Compass.
    total = await coll.count_documents({"source": "seed_production_sample"})
    pending = await coll.count_documents({
        "source": "seed_production_sample",
        "audit_status": "pending",
    })

    client.close()
    return {
        "samples": len(SAMPLES),
        "inserted": inserted,
        "updated": updated,
        "total_seed_rows_in_db": total,
        "pending_audit_status": pending,
    }


def main() -> None:
    stats = asyncio.run(_seed())
    logger.info(
        "Seed done: samples=%d inserted=%d updated=%d total_in_db=%d pending=%d",
        stats["samples"], stats["inserted"], stats["updated"],
        stats["total_seed_rows_in_db"], stats["pending_audit_status"],
    )


if __name__ == "__main__":
    main()
