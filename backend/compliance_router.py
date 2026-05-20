"""
compliance_router.py
====================
Compliance surface used by the Settings → Compliance tab.

Returns aggregated SOA + TCPA views for admin / compliance staff plus
CSV export endpoints. Reads only — no writes from this router today.
Scoping: every endpoint requires one of ``COMPLIANCE_ROLES``, so
ordinary agents get a 403 without touching the data.
"""
import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from deps import (
    COMPLIANCE_ROLES,
    get_db,
    require_roles,
)


router = APIRouter(prefix="/compliance", tags=["compliance"])


SOA_VALIDITY_DAYS = 365  # CMS: SOAs are valid for 12 months.


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


@router.get("/soa")
async def list_soa(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
    status: Optional[str] = Query(None, description="signed | pending | expired"),
    agent_email: Optional[str] = None,
    limit: int = Query(500, le=2000),
) -> Dict[str, Any]:
    """SOA dashboard payload — stats cards + records list.

    Records combine ``soa_records`` (signed) with leads that have an
    SOA workflow opened but no signature yet. Status is computed
    client-side from ``signed_at`` and the 12-month CMS validity window.
    """
    now = datetime.now(timezone.utc)
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # Build a leads-by-id index for joining contact info onto SOA records.
    leads_index: Dict[str, dict] = {}
    async for ld in db.leads.find(
        {},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "agent_id": 1, "agent_email": 1, "agent_name": 1,
         "soa_signed": 1, "soa_signed_at": 1, "created_at": 1},
    ):
        leads_index[ld["id"]] = ld

    records: List[Dict[str, Any]] = []
    cursor = db.soa_records.find({}, {"_id": 0})
    async for s in cursor:
        signed = _parse_iso(s.get("signed_at"))
        expires = signed + timedelta(days=SOA_VALIDITY_DAYS) if signed else None
        is_expired = bool(expires and expires < now)
        st = "expired" if is_expired else "signed"
        ld = leads_index.get(s.get("lead_id"), {})
        records.append({
            "id": s.get("id"),
            "lead_id": s.get("lead_id"),
            "lead_name": (
                f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip()
                or s.get("beneficiary_name")
                or "—"
            ),
            "agent_name": s.get("agent_name") or ld.get("agent_name"),
            "agent_email": ld.get("agent_email"),
            "sent_date": s.get("signed_at"),  # we don't track send separately
            "signed_date": s.get("signed_at"),
            "expires_at": expires.isoformat() if expires else None,
            "status": st,
            "products_discussed": s.get("plan_types_discussed") or [],
        })

    # "Pending" rows — leads that have soa_signed=False with a recent
    # touchpoint but no SOA record yet. Surface them so the agent can
    # nudge the client to sign.
    async for ld in db.leads.find(
        {"soa_signed": {"$ne": True}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "agent_name": 1, "agent_email": 1, "created_at": 1,
         "status": 1},
    ):
        if (ld.get("status") or "").lower() in ("lost", "not_interested"):
            continue
        records.append({
            "id": f"pending-{ld['id']}",
            "lead_id": ld["id"],
            "lead_name": f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip() or "—",
            "agent_name": ld.get("agent_name"),
            "agent_email": ld.get("agent_email"),
            "sent_date": ld.get("created_at"),
            "signed_date": None,
            "expires_at": None,
            "status": "pending",
            "products_discussed": [],
        })

    if status:
        records = [r for r in records if r["status"] == status]
    if agent_email:
        records = [r for r in records
                    if (r.get("agent_email") or "").lower() == agent_email.lower()]
    records.sort(key=lambda r: r.get("signed_date") or r.get("sent_date") or "",
                 reverse=True)
    records = records[:limit]

    # Stats — derived from the unfiltered view so the cards always tell
    # the truth even when the user has a status filter active.
    sent_mtd = 0
    signed_mtd = 0
    pending_total = 0
    expired_total = 0
    # Recount using leads + soa_records to avoid double counting from the
    # filtered records list above.
    async for s in db.soa_records.find({}, {"_id": 0, "signed_at": 1}):
        signed_dt = _parse_iso(s.get("signed_at"))
        if signed_dt and signed_dt >= mtd_start:
            signed_mtd += 1
            sent_mtd += 1
        if signed_dt and (signed_dt + timedelta(days=SOA_VALIDITY_DAYS)) < now:
            expired_total += 1
    pending_total = await db.leads.count_documents({
        "soa_signed": {"$ne": True},
        "status": {"$nin": ["lost", "not_interested"]},
    })

    return {
        "stats": {
            "sent_mtd": sent_mtd,
            "signed_mtd": signed_mtd,
            "pending": pending_total,
            "expired": expired_total,
        },
        "records": records,
    }


@router.get("/tcpa")
async def list_tcpa(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
    limit: int = Query(500, le=2000),
) -> Dict[str, Any]:
    """TCPA consent dashboard.

    Returns total / consented / no-consent counts plus the list of
    leads where ``tcpa_consent`` is missing or false. Leads created
    via the SPA intake set this explicitly; older rows may not have
    the field set, which we treat as "no consent on file".
    """
    total = await db.leads.count_documents({})
    consented = await db.leads.count_documents({"tcpa_consent": True})
    no_consent = total - consented

    cursor = db.leads.find(
        {"$or": [
            {"tcpa_consent": {"$exists": False}},
            {"tcpa_consent": False},
        ]},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "phone": 1, "email": 1, "lead_source": 1, "created_at": 1,
         "agent_name": 1, "agent_email": 1, "tcpa_consent": 1},
    ).sort("created_at", -1).limit(limit)

    leads: List[Dict[str, Any]] = []
    async for ld in cursor:
        leads.append({
            "id": ld.get("id"),
            "name": f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip() or "—",
            "phone": ld.get("phone") or "",
            "email": ld.get("email") or "",
            "lead_source": ld.get("lead_source") or "—",
            "created_at": ld.get("created_at"),
            "agent_name": ld.get("agent_name") or "",
        })

    rate = round(consented / total * 100, 1) if total else 0.0
    return {
        "stats": {
            "total": total,
            "consented": consented,
            "no_consent": no_consent,
            "consent_rate_pct": rate,
        },
        "leads": leads,
    }


def _csv_response(rows: List[List[Any]], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for r in rows:
        writer.writerow(r)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.read()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/soa.csv")
async def export_soa(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
) -> StreamingResponse:
    """CMS audit report — every SOA we have on file."""
    rows: List[List[Any]] = [[
        "soa_id", "lead_id", "beneficiary_name", "agent_name",
        "plan_types_discussed", "signed_at", "ip_address", "user_agent",
    ]]
    async for s in db.soa_records.find({}, {"_id": 0}):
        rows.append([
            s.get("id"),
            s.get("lead_id"),
            s.get("beneficiary_name"),
            s.get("agent_name"),
            "; ".join(s.get("plan_types_discussed") or []),
            s.get("signed_at"),
            s.get("ip_address") or "",
            s.get("user_agent") or "",
        ])
    return _csv_response(rows, "ghw_soa_audit.csv")


@router.get("/export/tcpa.csv")
async def export_tcpa(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
) -> StreamingResponse:
    """TCPA consent log — every lead with consent status + provenance."""
    rows: List[List[Any]] = [[
        "lead_id", "name", "phone", "email", "tcpa_consent",
        "tcpa_consent_at", "tcpa_consent_ip", "lead_source",
        "agent_name", "created_at",
    ]]
    async for ld in db.leads.find(
        {},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "phone": 1, "email": 1, "tcpa_consent": 1,
         "tcpa_consent_at": 1, "tcpa_consent_ip": 1, "lead_source": 1,
         "agent_name": 1, "created_at": 1},
    ):
        rows.append([
            ld.get("id"),
            f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip(),
            ld.get("phone") or "",
            ld.get("email") or "",
            "true" if ld.get("tcpa_consent") else "false",
            ld.get("tcpa_consent_at") or "",
            ld.get("tcpa_consent_ip") or "",
            ld.get("lead_source") or "",
            ld.get("agent_name") or "",
            ld.get("created_at") or "",
        ])
    return _csv_response(rows, "ghw_tcpa_consent.csv")
