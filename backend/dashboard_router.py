"""
dashboard_router.py
===================
Performance command-centre stats for /api/dashboard/stats.

Distinct from the /clients page (operational lead list): this surface
is *aggregate* — KPIs, charts, alerts, activity. Every query is scoped
through ``deps.agent_filter`` so agents see only their own numbers and
admin / compliance see agency-wide totals. When an admin impersonates
an agent via the ``X-Agent-ID`` header, scoping flips to that agent's
data via ``get_effective_agent`` so the dashboard mirrors what the
agent themselves would see.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request

from deps import (
    agent_filter,
    get_current_user,
    get_db,
    get_effective_agent,
)


logger = logging.getLogger("gruening.dashboard")
router = APIRouter(prefix="/dashboard", tags=["dashboard"])


VALID_PERIODS = ("mtd", "ytd", "last30", "last90", "all")


# ── Daily quote bank ─────────────────────────────────────────────────────
# Rotates by day-of-year so every user sees the same line each calendar
# day. Sources are mixed mindset/sales/discipline/winning; we attribute
# every line so the UI can show author + category. Keeping the bank
# inline rather than externalising — it changes infrequently and being
# offline-bundled means the dashboard never blanks out on a cache miss.
QUOTES = [
    # Andy Elliott
    {"text": "You're not tired, you're weak. There's a difference.",
     "author": "Andy Elliott", "category": "sales"},
    {"text": "The only way out is through the work.",
     "author": "Andy Elliott", "category": "discipline"},
    {"text": "Your customer doesn't care about your feelings. They care about solutions.",
     "author": "Andy Elliott", "category": "sales"},
    {"text": "Average is the enemy. Destroy it daily.",
     "author": "Andy Elliott", "category": "mindset"},
    {"text": "If you're not obsessed with being the best, someone else is.",
     "author": "Andy Elliott", "category": "winning"},
    # David Goggins
    {"text": "You are in danger of living a life so comfortable and soft that you will die without ever realizing your true potential.",
     "author": "David Goggins", "category": "discipline"},
    {"text": "Don't stop when you're tired. Stop when you're done.",
     "author": "David Goggins", "category": "discipline"},
    {"text": "The most important conversations you'll ever have are the ones you'll have with yourself.",
     "author": "David Goggins", "category": "mindset"},
    {"text": "Motivation is crap. Motivation comes and goes. When you're driven, whatever is in front of you will get destroyed.",
     "author": "David Goggins", "category": "mindset"},
    {"text": "We live in a world where mediocrity is rewarded and excellence is optional. Choose excellence.",
     "author": "David Goggins", "category": "winning"},
    # Chase Gruening
    {"text": "The agents who win aren't the most talented — they're the most consistent.",
     "author": "Chase Gruening", "category": "winning"},
    {"text": "Every Medicare client you don't reach is being reached by someone else.",
     "author": "Chase Gruening", "category": "sales"},
    {"text": "Build your book like you're building a legacy — one client at a time.",
     "author": "Chase Gruening", "category": "mindset"},
    {"text": "The phone doesn't dial itself. Pick it up.",
     "author": "Chase Gruening", "category": "discipline"},
    {"text": "Championship agents don't wait for AEP. They're ready before the whistle blows.",
     "author": "Chase Gruening", "category": "winning"},
    # Eric Thomas
    {"text": "When you want to succeed as bad as you want to breathe, then you'll be successful.",
     "author": "Eric Thomas", "category": "mindset"},
    {"text": "Pain is temporary. Quitting lasts forever.",
     "author": "Eric Thomas", "category": "discipline"},
    {"text": "Don't make a habit of choosing what feels good over what's actually good for you.",
     "author": "Eric Thomas", "category": "discipline"},
    {"text": "You can't cheat the grind. It knows how much you've invested.",
     "author": "Eric Thomas", "category": "winning"},
    # Grant Cardone
    {"text": "Your number one problem is you don't have enough leads.",
     "author": "Grant Cardone", "category": "sales"},
    {"text": "Obscurity is a bigger problem than money.",
     "author": "Grant Cardone", "category": "sales"},
    {"text": "The 10X rule: whatever you think it takes, multiply by 10.",
     "author": "Grant Cardone", "category": "mindset"},
    {"text": "Success is your duty, obligation, and responsibility.",
     "author": "Grant Cardone", "category": "winning"},
    {"text": "Average is a failing formula.",
     "author": "Grant Cardone", "category": "discipline"},
    # Jocko Willink
    {"text": "Discipline equals freedom.",
     "author": "Jocko Willink", "category": "discipline"},
    {"text": "Don't expect to be motivated every day. Be disciplined.",
     "author": "Jocko Willink", "category": "discipline"},
    {"text": "Good. When something goes wrong, say good. Now you have a chance to improve.",
     "author": "Jocko Willink", "category": "mindset"},
    {"text": "Extreme ownership: own everything in your world.",
     "author": "Jocko Willink", "category": "winning"},
    {"text": "Wake up early. Get after it.",
     "author": "Jocko Willink", "category": "discipline"},
    # Kobe Bryant
    {"text": "Rest at the end, not in the middle.",
     "author": "Kobe Bryant", "category": "discipline"},
    {"text": "The most important thing is to try and inspire people so that they can be great in whatever they want to do.",
     "author": "Kobe Bryant", "category": "mindset"},
    {"text": "Heroes come and go but legends are forever.",
     "author": "Kobe Bryant", "category": "winning"},
    {"text": "I can't relate to lazy people. We don't speak the same language.",
     "author": "Kobe Bryant", "category": "discipline"},
    {"text": "Everything negative — pressure, challenges — is all an opportunity for me to rise.",
     "author": "Kobe Bryant", "category": "mindset"},
    # Les Brown
    {"text": "You don't have to be great to get started, but you have to get started to be great.",
     "author": "Les Brown", "category": "mindset"},
    {"text": "Someone's opinion of you does not have to become your reality.",
     "author": "Les Brown", "category": "mindset"},
    {"text": "If you don't program yourself, life will program you.",
     "author": "Les Brown", "category": "discipline"},
    {"text": "Shoot for the moon. Even if you miss, you'll land among the stars.",
     "author": "Les Brown", "category": "winning"},
    # GHW-specific additions — insurance hustle, Medicare agents, agency building
    {"text": "The seniors you serve today fund the agency you build tomorrow.",
     "author": "GHW", "category": "mindset"},
    {"text": "AEP is won in March. Everyone else is just showing up in October.",
     "author": "GHW", "category": "winning"},
    {"text": "Every SOA is a promise. Honor it.",
     "author": "GHW", "category": "discipline"},
    {"text": "Renewals are the rent you pay on the relationship.",
     "author": "GHW", "category": "sales"},
    {"text": "Compliance isn't a hurdle. It's the foundation that lets you scale.",
     "author": "GHW", "category": "discipline"},
    {"text": "The agent who follows up three more times than the competition wins the book.",
     "author": "GHW", "category": "sales"},
    {"text": "Service is the only moat. Carriers can be replaced. Trust can't.",
     "author": "GHW", "category": "mindset"},
    {"text": "Document everything. Future-you will thank present-you.",
     "author": "GHW", "category": "discipline"},
    {"text": "Your CRM is a record of the work you did — or didn't.",
     "author": "GHW", "category": "discipline"},
    {"text": "Cross-sells aren't pushy. Leaving gaps in coverage is.",
     "author": "GHW", "category": "sales"},
    {"text": "An agency isn't built on one big sale. It's built on a thousand returned phone calls.",
     "author": "GHW", "category": "winning"},
    {"text": "Every audit log entry is a fingerprint of your professionalism.",
     "author": "GHW", "category": "discipline"},
    {"text": "The fastest agent isn't the smartest — they're the most prepared.",
     "author": "GHW", "category": "winning"},
    {"text": "If a client can't reach you in 24 hours, they'll reach someone else.",
     "author": "GHW", "category": "sales"},
    {"text": "Beneficiary review every year. No exceptions. That's how you keep the book.",
     "author": "GHW", "category": "discipline"},
]


def _quote_for_today() -> dict:
    """Pick today's quote by UTC day-of-year so every user sees the same
    line all day. Wrap-around (366 % 60) is fine — the rotation just
    repeats consistently."""
    doy = datetime.now(timezone.utc).timetuple().tm_yday
    idx = doy % len(QUOTES)
    return QUOTES[idx]


# ── Period resolution ────────────────────────────────────────────────────
def _period_start(period: str) -> Optional[datetime]:
    """Return the start-of-window for a given period, or None for "all".

    "mtd" anchors to the first day of the *current calendar month* in
    UTC — matching how agents read commission statements. "ytd" anchors
    to Jan 1 of the current year. Rolling windows use a fixed lookback.
    """
    now = datetime.now(timezone.utc)
    if period == "mtd":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if period == "ytd":
        return now.replace(month=1, day=1, hour=0, minute=0, second=0,
                            microsecond=0)
    if period == "last30":
        return now - timedelta(days=30)
    if period == "last90":
        return now - timedelta(days=90)
    return None  # "all"


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _month_key(iso_string: Optional[str]) -> Optional[str]:
    """Bucket an ISO timestamp into YYYY-MM. Tolerates None / malformed."""
    if not iso_string or not isinstance(iso_string, str):
        return None
    try:
        cleaned = iso_string.replace("Z", "+00:00") if iso_string.endswith("Z") else iso_string
        return datetime.fromisoformat(cleaned).strftime("%Y-%m")
    except Exception:
        return iso_string[:7] if len(iso_string) >= 7 else None


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _safe_float(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


# ── Aggregators ──────────────────────────────────────────────────────────
async def _lead_stats(db, scope: dict) -> Dict[str, Any]:
    cursor = db.leads.find(scope, {
        "_id": 0, "status": 1, "soa_signed": 1, "soa_signed_at": 1,
        "created_at": 1,
    })
    counts = Counter()
    soa_signed_mtd = 0
    mtd_start = _period_start("mtd")
    async for d in cursor:
        counts[(d.get("status") or "new").lower()] += 1
        signed_dt = _parse_iso(d.get("soa_signed_at"))
        if d.get("soa_signed") and signed_dt and mtd_start and signed_dt >= mtd_start:
            soa_signed_mtd += 1
    counts["total"] = sum(v for k, v in counts.items() if k != "total")
    return {
        "leads_total": counts["total"],
        "leads_new": counts.get("new", 0),
        "leads_contacted": counts.get("contacted", 0),
        "leads_qualified": counts.get("qualified", 0),
        "appointments_set": counts.get("appointment_set", 0),
        "leads_enrolled": counts.get("enrolled", 0),
        "leads_lost": counts.get("lost", 0),
        "soa_signed_mtd": soa_signed_mtd,
    }


async def _appointments_this_week(db, scope: dict) -> int:
    """Count leads whose status was changed to appointment_set in the last 7 days."""
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    q = {**scope, "status": "appointment_set", "updated_at": {"$gte": week_ago}}
    return await db.leads.count_documents(q)


async def _soa_stats(db, scope: dict) -> Dict[str, Any]:
    """SOA "sent" approximates to leads that have SOA workflow started.
    Today the portal only stamps soa_signed/soa_signed_at, so we use
    those as a proxy: soa_sent_mtd = soa_signed_mtd until the workflow
    tracks pre-signature sends explicitly. soa_pending counts leads with
    a partial SOA (signed_at unset but a soa_records row exists)."""
    mtd_start = _period_start("mtd")
    soa_signed_mtd = 0
    if mtd_start:
        soa_signed_mtd = await db.leads.count_documents({
            **scope,
            "soa_signed": True,
            "soa_signed_at": {"$gte": mtd_start.isoformat()},
        })
    # "pending" = leads where docs imply an SOA flow was opened but
    # signing never happened.
    soa_pending = await db.leads.count_documents({
        **scope,
        "soa_signed": False,
    })
    return {
        "soa_sent_mtd": soa_signed_mtd,
        "soa_signed_mtd": soa_signed_mtd,
        "soa_pending": soa_pending,
    }


async def _policy_stats(db, scope: dict) -> Dict[str, Any]:
    mtd_start = _period_start("mtd")
    ytd_start = _period_start("ytd")

    apps_mtd = 0
    apps_ytd = 0
    apps_pending = 0
    policies_active = 0
    policies_submitted_mtd = 0

    cursor = db["policies"].find(scope, {
        "_id": 0, "created_at": 1, "submitted_at": 1, "effective_date": 1,
        "policy_status": 1, "product_label": 1, "product_type": 1,
        "premium": 1,
    })
    product_count: Counter = Counter()
    product_revenue: Dict[str, float] = defaultdict(float)

    async for p in cursor:
        ts = p.get("submitted_at") or p.get("created_at")
        ts_dt = _parse_iso(ts)
        if ts_dt and mtd_start and ts_dt >= mtd_start:
            apps_mtd += 1
            policies_submitted_mtd += 1
        if ts_dt and ytd_start and ts_dt >= ytd_start:
            apps_ytd += 1
        if not p.get("effective_date"):
            apps_pending += 1
        status = (p.get("policy_status") or "").lower()
        if status == "active":
            policies_active += 1
        # Product breakdown — prefer human label, fall back to code.
        product = p.get("product_label") or p.get("product_type") or "Other"
        product_count[product] += 1
        product_revenue[product] += _safe_float(p.get("premium"))

    by_product = []
    for product, count in product_count.most_common():
        by_product.append({
            "product": product,
            "count": count,
            "revenue": round(product_revenue[product], 2),
        })

    return {
        "apps_submitted_mtd": apps_mtd,
        "apps_submitted_ytd": apps_ytd,
        "apps_pending": apps_pending,
        "policies_active": policies_active,
        "policies_submitted_mtd": policies_submitted_mtd,
        "policies_by_product": by_product,
    }


async def _revenue_stats(db, scope: dict) -> Dict[str, Any]:
    """Revenue is sourced from the production_records collection, which
    is the authoritative payout schedule (ComTrack + GHW import). We
    sum ``revenue_expected`` rather than received because the latter
    lags 30–60 days behind submission."""
    mtd_start = _period_start("mtd")
    ytd_start = _period_start("ytd")
    six_months_ago = (datetime.now(timezone.utc) - timedelta(days=180))

    revenue_mtd = 0.0
    revenue_ytd = 0.0
    monthly_buckets: Dict[str, float] = defaultdict(float)

    cursor = db["production_records"].find(scope, {
        "_id": 0, "app_date": 1, "revenue_expected": 1,
    })
    async for r in cursor:
        amt = _safe_float(r.get("revenue_expected"))
        app_dt = _parse_iso(r.get("app_date"))
        if not app_dt:
            continue
        if mtd_start and app_dt >= mtd_start:
            revenue_mtd += amt
        if ytd_start and app_dt >= ytd_start:
            revenue_ytd += amt
        if app_dt >= six_months_ago:
            monthly_buckets[app_dt.strftime("%Y-%m")] += amt

    # Fill in zero-rows for missing months so the chart x-axis is dense.
    now = datetime.now(timezone.utc)
    revenue_by_month = []
    for i in range(5, -1, -1):
        month_dt = (now.replace(day=15) - timedelta(days=30 * i))
        key = month_dt.strftime("%Y-%m")
        revenue_by_month.append({
            "month": key,
            "revenue": round(monthly_buckets.get(key, 0.0), 2),
        })

    return {
        "revenue_mtd": round(revenue_mtd, 2),
        "revenue_ytd": round(revenue_ytd, 2),
        "revenue_by_month": revenue_by_month,
    }


async def _alerts(db, scope: dict) -> List[Dict[str, Any]]:
    """Action items the agent should resolve.

    Sources:
      - soa_expiring: SOA records where signed_at + 365d < now + 7d
      - birthday_rule: Illinois leads whose DOB month/day falls in the
        next 90 days (eligible to switch Med Supp without underwriting)
      - app_pending_30d: policies created > 30d ago but no effective
        date stamped yet
      - commission_gap: production_records where revenue_received is
        null and app_date is > 60 days old
    """
    alerts: List[Dict[str, Any]] = []
    now = datetime.now(timezone.utc)

    # Build a lead lookup so we can attach names without N+1 queries.
    lead_ids: set = set()
    contact_ids: set = set()
    leads_by_id: Dict[str, dict] = {}
    leads_by_contact: Dict[str, dict] = {}

    async for ld in db.leads.find(scope, {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "state": 1, "date_of_birth": 1, "ghl_contact_id": 1,
    }):
        leads_by_id[ld["id"]] = ld
        if ld.get("ghl_contact_id"):
            leads_by_contact[ld["ghl_contact_id"]] = ld
        lead_ids.add(ld["id"])
        if ld.get("ghl_contact_id"):
            contact_ids.add(ld["ghl_contact_id"])

    def _name(lead: dict) -> str:
        first = lead.get("first_name") or ""
        last = lead.get("last_name") or ""
        return (first + " " + last).strip() or "Unknown lead"

    # soa_expiring — assumes 12-month expiry on signed SOA.
    if lead_ids:
        async for s in db.soa_records.find(
            {"lead_id": {"$in": list(lead_ids)}},
            {"_id": 0, "lead_id": 1, "signed_at": 1},
        ):
            signed = _parse_iso(s.get("signed_at"))
            if not signed:
                continue
            expires = signed + timedelta(days=365)
            days_left = (expires - now).days
            if 0 <= days_left <= 7:
                lead = leads_by_id.get(s["lead_id"], {})
                alerts.append({
                    "type": "soa_expiring",
                    "message": f"SOA expires in {days_left} day(s)",
                    "lead_id": s["lead_id"],
                    "lead_name": _name(lead),
                    "urgency": "high" if days_left <= 2 else "medium",
                })

    # birthday_rule — Illinois only.
    for lid, lead in leads_by_id.items():
        if (lead.get("state") or "").upper() != "IL":
            continue
        dob = _parse_iso(lead.get("date_of_birth"))
        if not dob:
            continue
        try:
            this_year_birthday = dob.replace(year=now.year, tzinfo=timezone.utc)
        except ValueError:
            continue
        if this_year_birthday < now:
            try:
                this_year_birthday = dob.replace(year=now.year + 1,
                                                  tzinfo=timezone.utc)
            except ValueError:
                continue
        days_until = (this_year_birthday - now).days
        if 0 <= days_until <= 90:
            alerts.append({
                "type": "birthday_rule",
                "message": f"IL Birthday Rule eligible — birthday in {days_until} day(s)",
                "lead_id": lid,
                "lead_name": _name(lead),
                "urgency": "medium" if days_until <= 30 else "low",
            })

    # app_pending_30d — policies older than 30d with no effective_date.
    cutoff_30d = (now - timedelta(days=30))
    async for p in db["policies"].find(
        {**scope, "$or": [
            {"effective_date": {"$exists": False}},
            {"effective_date": None},
            {"effective_date": ""},
        ]},
        {"_id": 0, "policy_id": 1, "ghl_contact_id": 1, "contact_name": 1,
         "submitted_at": 1, "created_at": 1, "product_label": 1},
    ):
        ts = _parse_iso(p.get("submitted_at") or p.get("created_at"))
        if not ts or ts > cutoff_30d:
            continue
        contact_id = p.get("ghl_contact_id")
        lead = leads_by_contact.get(contact_id, {})
        alerts.append({
            "type": "app_pending_30d",
            "message": f"{p.get('product_label') or 'Application'} pending > 30 days",
            "lead_id": lead.get("id") or "",
            "lead_name": _name(lead) if lead else (p.get("contact_name") or "Unknown"),
            "urgency": "high",
        })

    # commission_gap — production_records where effective_date falls
    # inside the 60-120-days-ago window (carriers typically pay within
    # 60 days, so anything older than 60d but younger than 120d is a
    # real gap; rows older than 120d are stale and likely never paid).
    # Capped at 10 most-recent.
    cutoff_120d = now - timedelta(days=120)
    cutoff_60d = now - timedelta(days=60)
    commission_gap_alerts: List[Dict[str, Any]] = []
    async for r in db["production_records"].find(
        {**scope, "$or": [
            {"revenue_received": None},
            {"revenue_received": {"$exists": False}},
        ]},
        {"_id": 0, "app_date": 1, "effective_date": 1, "client_name": 1,
         "carrier": 1, "product_type": 1, "revenue_expected": 1},
    ):
        # effective_date is the carrier's policy effective date — the
        # right clock for commission timing. Fall back to app_date for
        # rows that haven't had it filled in yet.
        eff_dt = _parse_iso(r.get("effective_date")) or _parse_iso(r.get("app_date"))
        if not eff_dt:
            continue
        if not (cutoff_120d <= eff_dt < cutoff_60d):
            continue
        if _safe_float(r.get("revenue_expected")) <= 0:
            continue
        commission_gap_alerts.append({
            "type": "commission_gap",
            "message": f"Commission missing — {r.get('carrier') or 'carrier'} {r.get('product_type') or ''}".strip(),
            "lead_id": "",
            "lead_name": r.get("client_name") or "Unknown client",
            "urgency": "medium",
            "_sort_dt": eff_dt,
        })
    commission_gap_alerts.sort(key=lambda a: a["_sort_dt"], reverse=True)
    for a in commission_gap_alerts[:10]:
        a.pop("_sort_dt", None)
        alerts.append(a)

    # Stable urgency ordering for the UI.
    urgency_order = {"high": 0, "medium": 1, "low": 2}
    alerts.sort(key=lambda a: urgency_order.get(a["urgency"], 9))
    return alerts[:50]


async def _recent_activity(db, scope: dict, current_user: dict) -> List[Dict[str, Any]]:
    """Last 20 audit events relevant to the active scope.

    For agents we filter to the agent's own actor_id. For admin / impersonating
    we surface either everything (admin without X-Agent-ID) or the impersonated
    agent's events. Since audit_logs aren't agent-scoped via agent_id, we use
    actor_id (or scope by actor_id from the user being viewed).
    """
    actor_id = scope.get("agent_id") or current_user.get("id")
    role = current_user.get("role")
    if role in ("admin", "compliance") and "agent_id" not in scope:
        # Agency-wide
        query: dict = {}
    else:
        query = {"actor_id": actor_id}
    cursor = (
        db.audit_logs.find(
            query,
            {"_id": 0, "event_type": 1, "timestamp": 1, "actor_email": 1,
             "target_type": 1, "target_id": 1, "metadata": 1},
        )
        .sort("timestamp", -1)
        .limit(20)
    )
    out = []
    async for e in cursor:
        out.append({
            "timestamp": e.get("timestamp"),
            "action": e.get("event_type"),
            "description": _humanize_event(e),
            "lead_name": (e.get("metadata") or {}).get("contact_name")
                          or (e.get("metadata") or {}).get("lead_name")
                          or "",
        })
    return out


_EVENT_LABELS = {
    "lead_created": "Lead created",
    "lead_updated": "Lead updated",
    "ghl_sync": "Synced to GHL",
    "ghl_sync_failed": "GHL sync failed",
    "ghl_lead_created": "Lead created from GHL",
    "ghl_lead_updated": "Lead updated from GHL",
    "ghl_lead_pushed": "Lead pushed to GHL",
    "doc_uploaded": "Document uploaded",
    "doc_downloaded": "Document downloaded",
    "soa_signed": "SOA signed",
    "ai_chat_message": "AI assistant message",
    "agent_status_changed": "Agent status changed",
}


def _humanize_event(e: dict) -> str:
    label = _EVENT_LABELS.get(e.get("event_type"), e.get("event_type") or "")
    return label.replace("_", " ")


async def _admin_agent_breakdown(db) -> List[Dict[str, Any]]:
    """Per-agent rollup powering the admin "Agent Performance" table.

    Mirrors what /api/agents already computes (lead/policy counts +
    revenue) so the admin dashboard can render without a separate
    fetch."""
    mtd_start = _period_start("mtd")
    mtd_iso = _iso(mtd_start) if mtd_start else None

    # All agents (only role == agent for the perf table — admins don't
    # need a row about themselves).
    users = await db.users.find(
        {"role": "agent"},
        {"_id": 0, "id": 1, "full_name": 1, "email": 1, "agent_name": 1},
    ).to_list(length=500)
    by_id = {u["id"]: u for u in users}

    # Counters per agent
    leads_total: Dict[str, int] = defaultdict(int)
    apps_mtd: Dict[str, int] = defaultdict(int)
    revenue_mtd: Dict[str, float] = defaultdict(float)
    policies_active: Dict[str, int] = defaultdict(int)
    leads_enrolled: Dict[str, int] = defaultdict(int)

    async for ld in db.leads.find(
        {"agent_id": {"$in": list(by_id.keys())}},
        {"_id": 0, "agent_id": 1, "status": 1},
    ):
        leads_total[ld["agent_id"]] += 1
        if (ld.get("status") or "").lower() == "enrolled":
            leads_enrolled[ld["agent_id"]] += 1

    pol_q: dict = {"agent_id": {"$in": list(by_id.keys())}}
    async for p in db["policies"].find(pol_q, {
        "_id": 0, "agent_id": 1, "submitted_at": 1, "created_at": 1,
        "policy_status": 1,
    }):
        if (p.get("policy_status") or "").lower() == "active":
            policies_active[p["agent_id"]] += 1
        ts = _parse_iso(p.get("submitted_at") or p.get("created_at"))
        if mtd_start and ts and ts >= mtd_start:
            apps_mtd[p["agent_id"]] += 1

    async for r in db["production_records"].find(
        {"agent_id": {"$in": list(by_id.keys())}},
        {"_id": 0, "agent_id": 1, "app_date": 1, "revenue_expected": 1},
    ):
        app_dt = _parse_iso(r.get("app_date"))
        if mtd_start and app_dt and app_dt >= mtd_start:
            revenue_mtd[r["agent_id"]] += _safe_float(r.get("revenue_expected"))

    rows = []
    for uid, u in by_id.items():
        leads = leads_total.get(uid, 0)
        enrolled = leads_enrolled.get(uid, 0)
        conv = round((enrolled / leads * 100), 1) if leads else 0.0
        rows.append({
            "agent_id": uid,
            "agent_name": u.get("agent_name") or u.get("full_name") or u.get("email"),
            "leads": leads,
            "apps_mtd": apps_mtd.get(uid, 0),
            "revenue_mtd": round(revenue_mtd.get(uid, 0.0), 2),
            "policies_active": policies_active.get(uid, 0),
            "conversion_rate": conv,
        })
    rows.sort(key=lambda r: r["revenue_mtd"], reverse=True)
    return rows


async def _top_carriers(db, scope: dict) -> List[Dict[str, Any]]:
    counts: Counter = Counter()
    async for r in db["production_records"].find(scope, {"_id": 0, "carrier": 1}):
        c = (r.get("carrier") or "").strip()
        if c:
            counts[c] += 1
    return [{"carrier": k, "count": v} for k, v in counts.most_common(8)]


# ── Route ────────────────────────────────────────────────────────────────
@router.get("/stats")
async def dashboard_stats(
    request: Request,
    period: str = Query("mtd", description="mtd|ytd|last30|last90|all"),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
    db=Depends(get_db),
):
    """Aggregated stats for the dashboard.

    Scoping rules:
      - Agent role         → always sees only their own data.
      - Admin / compliance → agency-wide by default; X-Agent-ID header
        narrows to that agent for the "view as agent" flow.
    """
    if period not in VALID_PERIODS:
        period = "mtd"

    # Daily quote is computed first and lives outside the try/except
    # below so a transient Mongo outage never blanks the inspirational
    # banner — date arithmetic only, no DB calls.
    quote = _quote_for_today()

    role = current_user.get("role", "agent")
    impersonating = bool(effective.get("_impersonated_by"))
    if impersonating:
        scope = {"agent_id": effective["id"]}
    else:
        scope = agent_filter(current_user)

    try:
        lead_stats = await _lead_stats(db, scope)
        appt_week = await _appointments_this_week(db, scope)
        soa_stats = await _soa_stats(db, scope)
        policy_stats = await _policy_stats(db, scope)
        revenue_stats = await _revenue_stats(db, scope)
        alerts = await _alerts(db, scope)
        activity = await _recent_activity(db, scope, current_user)

        # Admin extras — only computed for the agency-wide view (not when
        # impersonating).
        admin_extras: Dict[str, Any] = {}
        if role in ("admin", "compliance") and not impersonating:
            admin_extras = {
                "agents_active": await _active_team_today(db),
                "agent_breakdown": await _admin_agent_breakdown(db),
                "top_carriers": await _top_carriers(db, {}),
            }

        pipeline_funnel = {
            "new": lead_stats.get("leads_new", 0),
            "contacted": lead_stats.get("leads_contacted", 0),
            "qualified": lead_stats.get("leads_qualified", 0),
            "appointment_set": lead_stats.get("appointments_set", 0),
            "enrolled": lead_stats.get("leads_enrolled", 0),
        }

        return {
            "period": period,
            "scope": "agent" if scope else "agency",
            "impersonating": impersonating,
            "impersonated_agent": effective.get("full_name") if impersonating else None,
            "daily_quote": quote,
            **lead_stats,
            "appointments_this_week": appt_week,
            **soa_stats,
            **policy_stats,
            **revenue_stats,
            "pipeline_funnel": pipeline_funnel,
            "alerts": alerts,
            "recent_activity": activity,
            **admin_extras,
        }
    except Exception as e:
        # Mongo or aggregation hiccup — never let it black out the
        # whole dashboard. The frontend still gets the quote (which
        # we computed before any DB work) and a partial-data flag.
        logger.exception("dashboard_stats partial failure: %s", e)
        return {
            "daily_quote": quote,
            "error": "partial data",
        }


async def _active_team_today(db) -> int:
    """Count team members with any audit_log activity today, regardless
    of role. Falls back to total active users when nobody has touched
    the system yet today — better than reporting "0 agents active" on
    a fresh morning."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        actor_ids = set()
        async for ev in db.audit_logs.find(
            {"timestamp": {"$gte": today_start.isoformat()}},
            {"_id": 0, "actor_id": 1},
        ):
            aid = ev.get("actor_id")
            if aid:
                actor_ids.add(aid)
        if actor_ids:
            return await db.users.count_documents(
                {"id": {"$in": list(actor_ids)}, "is_active": True},
            )
    except Exception as e:
        logger.warning("_active_team_today aggregation failed: %s", e)
    # Fallback: total active users.
    try:
        return await db.users.count_documents({"is_active": True})
    except Exception:
        return 0
