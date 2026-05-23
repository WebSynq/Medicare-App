#!/usr/bin/env python3
"""
seed_demo_account.py — populate Jane Smith's account with realistic
Medicare demo data so leadership can see a live-looking dashboard.

Standalone — not part of the main app. Run manually:

    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/seed_demo_account.py

PowerShell from E:\\Projects\\Medicare-App\\backend:

    $env:MONGO_URL='mongodb+srv://...'
    $env:DB_NAME='gruening_medicare'
    python scripts\\seed_demo_account.py

Idempotent: re-running on an already-seeded account does nothing
(checked via the created_via="demo_seed" marker on Jane's leads).
"""
import asyncio
import os
import random
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Allow running from either `python backend/scripts/seed_demo_account.py`
# or from inside backend/scripts/ directly.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


DEMO_EMAIL = "tdcs.az.tim@gmail.com"
AGENCY_ID = "ghw_001"
AGENCY_NAME = "James Town Medi"
DEMO_MARKER = "demo_seed"

# Deterministic seed so re-runs (if the idempotency marker is wiped)
# produce the same fake data — easier to spot regressions when the
# demo is "the same numbers" across deploys.
random.seed(20260523)

# Phone area codes by state — keeps the fake numbers regionally
# plausible enough that a demo viewer doesn't pattern-match them as
# obviously seeded.
AREA_CODES = {
    "IL": ["312", "773", "630", "847", "708", "815", "224"],
    "IN": ["317", "765", "812", "574"],
    "WI": ["414", "608", "262"],
    "MO": ["314", "636", "417"],
}

# Per-product agent commission estimate the dashboard cards expect.
# Plan G + Plan N + Plan F are flat-dollar estimates for IL Med Supp;
# MA is the flat $313 first-year payout; PDP is $30 ($100 × 30%).
COMMISSION = {
    "Plan G":  387.0,
    "Plan N":  280.0,
    "Plan F":  360.0,
    "MA":      313.0,
    "PDP":     30.0,
}

# Canonical lead list. Order matters — indices 0..3 are the enrolled
# four (used as appointment "completed" targets), 4..7 are qualified
# (no_show targets), 8..10 are appointment_set (scheduled targets).
LEADS = [
    # idx, first, last, age, status, plan, carrier, state, lead_source
    (0,  "Margaret", "Sullivan",  72, "enrolled",        "Plan G", "Mutual of Omaha",       "IL", "Facebook"),
    (1,  "Robert",   "Chen",      68, "enrolled",        "Plan N", "Aetna",                 "IL", "Referral"),
    (2,  "Dorothy",  "Williams",  75, "enrolled",        "MA",     "Humana",                "IL", "Direct Mail"),
    (3,  "James",    "Patterson", 71, "enrolled",        "Plan G", "Blue Cross Blue Shield","IL", "Website"),
    (4,  "Barbara",  "Martinez",  69, "qualified",       "Plan G", "Cigna",                 "IL", "Phone Inquiry"),
    (5,  "William",  "Thompson",  74, "qualified",       "Plan N", "UnitedHealthcare",      "IL", "Facebook"),
    (6,  "Linda",    "Garcia",    67, "qualified",       "PDP",    "Wellcare",              "IL", "Agent Referral"),
    (7,  "Charles",  "Anderson",  70, "qualified",       "Plan G", "Mutual of Omaha",       "IN", "Referral"),
    (8,  "Patricia", "Johnson",   73, "appointment_set", "Plan G", "Aetna",                 "IL", "Website"),
    (9,  "Michael",  "Brown",     66, "appointment_set", "MA",     "Humana",                "IL", "Direct Mail"),
    (10, "Nancy",    "Davis",     77, "appointment_set", "Plan N", "Blue Cross Blue Shield","IL", "Facebook"),
    (11, "Thomas",   "Wilson",    65, "contacted",       "Plan G", "Cigna",                 "IL", "Phone Inquiry"),
    (12, "Sandra",   "Moore",     71, "contacted",       "PDP",    "Wellcare",              "IL", "Agent Referral"),
    (13, "Daniel",   "Taylor",    68, "contacted",       "Plan G", "UnitedHealthcare",      "WI", "Referral"),
    (14, "Betty",    "Jackson",   76, "new",             "Plan G", "Mutual of Omaha",       "IL", "Website"),
    (15, "Richard",  "White",     69, "new",             "MA",     "Humana",                "IL", "Direct Mail"),
    (16, "Carol",    "Harris",    72, "new",             "Plan N", "Aetna",                 "IL", "Facebook"),
    (17, "Joseph",   "Martin",    74, "not_interested",  "Plan G", "Blue Cross Blue Shield","MO", "Phone Inquiry"),
    (18, "Helen",    "Thompson",  67, "not_interested",  "PDP",    "Wellcare",              "IL", "Agent Referral"),
    (19, "Frank",    "Robinson",  78, "lost",            "Plan G", "Cigna",                 "IL", "Referral"),
]


def _fake_phone(state: str) -> str:
    area = random.choice(AREA_CODES.get(state, AREA_CODES["IL"]))
    return f"{area}-{random.randint(200, 999)}-{random.randint(1000, 9999)}"


def _fake_email(first: str, last: str) -> str:
    return f"{first.lower()}.{last.lower()}@example.com"


def _dob_from_age(age: int) -> str:
    # Spread DOBs across the year so birthdays don't all bunch on
    # today. Year = today.year - age, month/day random.
    today = date.today()
    year = today.year - age
    month = random.randint(1, 12)
    # Day-of-month safe across all months.
    day = random.randint(1, 28)
    return date(year, month, day).isoformat()


def _medicare_part_dates(age: int) -> tuple[str, str]:
    """Part A + B effective dates. Both default to "the month after
    65th birthday" which matches the most common enrollment path."""
    today = date.today()
    sixtyfifth = today.replace(year=today.year - age + 0)
    # Synthesise an enrollment date — first of the month following the
    # 65th. Clamp to "the past" so we don't generate future Part A dates.
    eff_month = sixtyfifth.month + 1 if sixtyfifth.month < 12 else 1
    eff_year = sixtyfifth.year if sixtyfifth.month < 12 else sixtyfifth.year + 1
    if date(eff_year, eff_month, 1) >= today:
        eff_year = today.year - 1
    part_a = date(eff_year, eff_month, 1).isoformat()
    return part_a, part_a


def _spread_created_at(idx: int, total: int) -> datetime:
    """Spread leads' created_at across the last 90 days, oldest first
    so the enrolled leads (early indices) read as "older" relationships."""
    now = datetime.now(timezone.utc)
    days_back = int(90 * (1 - (idx / max(total - 1, 1))))
    # Jitter so two leads at the same index ratio don't share a
    # timestamp.
    days_back += random.randint(-3, 3)
    days_back = max(0, min(days_back, 90))
    return now - timedelta(days=days_back, hours=random.randint(0, 23))


def _build_lead(spec, agent_id: str) -> dict:
    idx, first, last, age, status, plan, carrier, state, lead_source = spec
    full = f"{first} {last}"
    created = _spread_created_at(idx, len(LEADS))
    part_a, part_b = _medicare_part_dates(age)
    return {
        "id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "agent_name": "Jane Smith",
        "agency_id": AGENCY_ID,
        "agency_name": AGENCY_NAME,
        "full_name": full,
        "first_name": first,
        "last_name": last,
        "email": _fake_email(first, last),
        "phone": _fake_phone(state),
        "date_of_birth": _dob_from_age(age),
        "state": state,
        "status": status,
        "current_carrier": carrier,
        "plan_type_premium": plan,
        # Calculator-friendly hints — keep these in sync with the
        # commissions dashboard's per-row commission resolver.
        "product_interest": plan,
        "lead_source": lead_source,
        "created_via": DEMO_MARKER,
        "created_at": created.isoformat(),
        "updated_at": created.isoformat(),
        "tcpa_consent": True,
        "tcpa_consent_timestamp": created.isoformat(),
        "tcpa_consent_ip": "127.0.0.1",
        "medicare_part_a_effective": part_a,
        "medicare_part_b_effective": part_b,
        "estimated_commission": COMMISSION.get(plan, 0.0),
    }


def _build_appointments(leads_by_idx: dict, agent_id: str) -> list[dict]:
    """Eight appointments spread past/present/future, linked to the
    leads at the documented indices."""
    today = date.today()
    appts_spec = [
        # (lead_idx, day_offset, time, duration, type, status, note, outcome)
        (0,  -21, "10:00", 30, "enrollment",           "completed",
         "Closed Plan G enrollment — effective next month.",
         "Enrolled in Mutual of Omaha Plan G; effective date set."),
        (1,  -14, "14:00", 60, "enrollment",           "completed",
         "Final paperwork signed for Plan N.",
         "Enrolled in Aetna Plan N."),
        (2,  -7,  "09:30", 60, "enrollment",           "completed",
         "MAPD plan walkthrough complete.",
         "Enrolled in Humana MA-PD HMO."),
        (8,   0,  "10:00", 30, "plan_review",          "scheduled",
         "Compare Plan G vs Plan N premiums.", None),
        (9,   1,  "13:00", 60, "initial_consultation", "scheduled",
         "First meeting — review current Medicare gaps.", None),
        (10,  7,  "11:00", 30, "plan_review",          "scheduled",
         "Annual review — confirm Plan N still best fit.", None),
        (4,  -14, "10:30", 30, "initial_consultation", "no_show",
         "Client did not answer. Reschedule attempted.",
         "No-show; voicemail left for follow-up."),
        (5,  -14, "15:00", 30, "plan_review",          "no_show",
         "Client missed appointment.",
         "Did not arrive; will follow up next week."),
    ]
    rows = []
    for lead_idx, days, time_str, duration, ap_type, status, note, outcome in appts_spec:
        lead = leads_by_idx[lead_idx]
        ap_date = (today + timedelta(days=days)).isoformat()
        created_at = (datetime.now(timezone.utc)
                       - timedelta(days=max(7, abs(days) + 7))).isoformat()
        rows.append({
            "appointment_id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "agent_name": "Jane Smith",
            "agency_id": AGENCY_ID,
            "lead_id": lead["id"],
            "client_name": lead["full_name"],
            "appointment_date": ap_date,
            "appointment_time": time_str,
            "duration_minutes": duration,
            "type": ap_type,
            "status": status,
            "notes": note,
            "outcome": outcome,
            "estimated_commission": lead.get("estimated_commission"),
            "created_via": DEMO_MARKER,
            "created_at": created_at,
            "updated_at": created_at,
        })
    return rows


def _build_notes(leads_by_idx: dict, agent_id: str) -> list[dict]:
    """Ten notes mixing call logs, generic notes, and follow-up tasks
    across various leads. Mix of completed + open tasks so the Tasks
    panel has something to demo."""
    today = date.today()
    now_dt = datetime.now(timezone.utc)
    spec = [
        # (lead_idx, type, content, is_task, due_offset, completed)
        (0,  "call", "Called Margaret, discussed Plan G benefits vs current Plan F. Concerned about premium increase.", False, None, False),
        (0,  "note", "Sent Plan G comparison sheet via email per Margaret's request.", False, None, False),
        (4,  "call", "Barbara wants a Plan N quote for comparison. Following up with carrier rates.", False, None, False),
        (8,  "call", "Left voicemail for Patricia. Asked her to call back Thursday afternoon.", False, None, False),
        (2,  "note", "Completed enrollment for Plan G — effective date 06/01/2026.", False, None, False),
        (5,  "task", "Follow up with William re: Plan N rate quote.", True, 3, False),
        (9,  "task", "Send Medicare 101 PDF before Tuesday's meeting.", True, 1, False),
        (10, "task", "Confirm Nancy's annual review for next week.", True, 5, False),
        (1,  "task", "Mail welcome packet — Robert's Plan N enrollment.", True, -2, True),
        (12, "email", "Emailed Sandra the PDP carrier comparison she requested.", False, None, False),
    ]
    rows = []
    for lead_idx, ntype, content, is_task, due_offset, completed in spec:
        lead = leads_by_idx[lead_idx]
        created_at = (now_dt - timedelta(days=random.randint(1, 25))).isoformat()
        doc = {
            "note_id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "agent_name": "Jane Smith",
            "agency_id": AGENCY_ID,
            "lead_id": lead["id"],
            "type": ntype,
            "content": content,
            "is_task": bool(is_task),
            "task_due_date": (today + timedelta(days=due_offset)).isoformat() if is_task else None,
            "task_completed": bool(completed),
            "task_completed_at": now_dt.isoformat() if completed else None,
            "deleted": False,
            "created_via": DEMO_MARKER,
            "created_at": created_at,
            "updated_at": created_at,
        }
        rows.append(doc)
    return rows


async def _run() -> int:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME", "gruening_medicare")
    if not mongo_url:
        print("ERROR: MONGO_URL env var is required.", file=sys.stderr)
        return 1

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    # 1. Find Jane.
    jane = await db.users.find_one({"email": DEMO_EMAIL}, {"_id": 0})
    if not jane:
        print(
            f"ERROR: no user found with email {DEMO_EMAIL}. "
            "Invite + register Jane first, then re-run this script.",
            file=sys.stderr,
        )
        return 2
    agent_id = jane["id"]
    print(
        f"Found user {DEMO_EMAIL} → id={agent_id} role={jane.get('role')}"
    )

    # 2. Idempotency check.
    existing = await db.leads.count_documents({
        "agent_id": agent_id,
        "created_via": DEMO_MARKER,
    })
    if existing > 0:
        print(
            f"Demo data already exists ({existing} demo leads). "
            "Exiting without changes."
        )
        return 0

    # 3. Build + insert leads.
    lead_docs = [_build_lead(spec, agent_id) for spec in LEADS]
    await db.leads.insert_many(lead_docs)
    leads_by_idx = {spec[0]: lead_docs[i] for i, spec in enumerate(LEADS)}

    # 4. Appointments linked to specific leads.
    appt_docs = _build_appointments(leads_by_idx, agent_id)
    await db.appointments.insert_many(appt_docs)

    # 5. Notes + tasks.
    note_docs = _build_notes(leads_by_idx, agent_id)
    await db.notes.insert_many(note_docs)

    print()
    print("Demo data seeded for Jane Smith:")
    print(f"  - {len(lead_docs)} leads created")
    print(f"  - {len(appt_docs)} appointments created")
    print(f"  - {len(note_docs)} notes created")
    print(f"  Login: {DEMO_EMAIL}")
    print("  View at: https://app.ghwcrm.com")
    print()
    print("Re-running this script is a no-op until the demo_seed leads "
          "are deleted from MongoDB.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
