"""Agency tag library + per-lead tag application.

Tags are a free-form, normalized label system. The library lives in
``db.tags`` (one row per (agency_id, name)) and carries display metadata
(label, color, category). Application is a simple ``Lead.tags`` list of
the normalized names — kept separate so deleting a library entry never
mutates leads.

Normalization rule lives in ``models.normalize_tag_name`` — every code
path that turns a human label into a name goes through it so "Hot Lead",
"hot lead", and "HOT-LEAD" all resolve to ``hot-lead``.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from models import Tag, TagCreate, normalize_tag_name
from deps import (
    get_db,
    get_phi_db,
    get_current_user,
    get_agency_id,
    require_roles,
    write_audit,
)
from encryption import safe_lead_set, safe_lead_load


logger = logging.getLogger(__name__)

router = APIRouter(tags=["tags"])


# Pre-built Medicare tag library — seeded on startup for every agency
# that doesn't yet have a tags collection populated. Updating this list
# does NOT retroactively patch existing agencies; the seed is run only
# when no tags exist for that agency_id, so first-boot is the one chance
# to land everything. Re-running on a populated agency is a no-op.
SEED_TAGS: List[dict] = [
    # status
    {"name": "hot-lead",            "label": "Hot Lead",            "color": "#ef4444", "category": "status"},
    {"name": "warm-lead",           "label": "Warm Lead",           "color": "#f59e0b", "category": "status"},
    {"name": "cold-lead",           "label": "Cold Lead",           "color": "#3b82f6", "category": "status"},
    {"name": "callback-requested",  "label": "Callback Requested",  "color": "#8b5cf6", "category": "status"},
    {"name": "do-not-call",         "label": "Do Not Call",         "color": "#0f172a", "category": "status"},
    # product
    {"name": "mapd-interested",          "label": "MAPD Interested",          "color": "#7c3aed", "category": "product"},
    {"name": "supplement-interested",    "label": "Supplement Interested",    "color": "#2563eb", "category": "product"},
    {"name": "pdp-interested",           "label": "PDP Interested",           "color": "#0ea5e9", "category": "product"},
    {"name": "final-expense-interested", "label": "Final Expense Interested", "color": "#db2777", "category": "product"},
    {"name": "annuity-interested",       "label": "Annuity Interested",       "color": "#64748b", "category": "product"},
    # medicare-lifecycle
    {"name": "turning-65",              "label": "Turning 65",              "color": "#10b981", "category": "medicare"},
    {"name": "birthday-rule-eligible",  "label": "Birthday Rule Eligible",  "color": "#14b8a6", "category": "medicare"},
    {"name": "anoc-review-needed",      "label": "ANOC Review Needed",      "color": "#f97316", "category": "medicare"},
    {"name": "dual-eligible",           "label": "Dual Eligible",           "color": "#06b6d4", "category": "medicare"},
    {"name": "employer-coverage",       "label": "Employer Coverage",       "color": "#a16207", "category": "medicare"},
    {"name": "annual-review-complete",  "label": "Annual Review Complete",  "color": "#15803d", "category": "medicare"},
    # compliance
    {"name": "tcpa-opted-out",     "label": "TCPA Opted Out",     "color": "#991b1b", "category": "compliance"},
    {"name": "soa-pending",        "label": "SOA Pending",        "color": "#d97706", "category": "compliance"},
    {"name": "soa-signed",         "label": "SOA Signed",         "color": "#16a34a", "category": "compliance"},
    {"name": "enrolled",           "label": "Enrolled",           "color": "#059669", "category": "compliance"},
    {"name": "lost-to-competitor", "label": "Lost to Competitor", "color": "#6b7280", "category": "compliance"},
]


async def seed_tag_library(db: AsyncIOMotorDatabase) -> int:
    """Seed the pre-built Medicare tag library for the current agency.

    Idempotent. Returns the number of tags inserted (0 when the library
    is already populated for this agency). Safe to call on every boot.
    """
    agency = get_agency_id()
    existing = await db.tags.count_documents({"agency_id": agency})
    if existing > 0:
        return 0

    now_iso = datetime.now(timezone.utc).isoformat()
    docs: List[dict] = []
    for entry in SEED_TAGS:
        docs.append(Tag(
            agency_id=agency,
            name=entry["name"],
            label=entry["label"],
            color=entry["color"],
            category=entry["category"],
            created_by="system_seed",
            created_at=now_iso,
        ).model_dump())
    if docs:
        await db.tags.insert_many(docs)
    return len(docs)


# ── Library routes ────────────────────────────────────────────────────────

@router.get("/tags")
async def list_tags(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Return the agency tag library sorted by category, then label."""
    agency = get_agency_id()
    cursor = db.tags.find({"agency_id": agency}, {"_id": 0}).sort(
        [("category", 1), ("label", 1)],
    )
    tags = await cursor.to_list(length=None)
    return {"tags": tags}


@router.post("/tags", status_code=201)
async def create_tag(
    payload: TagCreate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Create a custom tag. Admin / owner only.

    Normalizes the label to a name; rejects duplicates inside the agency
    rather than silently merging so the caller knows their tag already
    existed (and can fetch it via GET /api/tags).
    """
    name = normalize_tag_name(payload.label)
    if not name:
        raise HTTPException(
            status_code=422,
            detail="Label must contain at least one alphanumeric character.",
        )
    agency = get_agency_id()
    existing = await db.tags.find_one(
        {"agency_id": agency, "name": name}, {"_id": 0},
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Tag '{name}' already exists in the agency library.",
        )

    tag = Tag(
        agency_id=agency,
        name=name,
        label=payload.label.strip(),
        color=payload.color,
        category=payload.category,
        created_by=current_user.get("id"),
    )
    await db.tags.insert_one(tag.model_dump())
    await write_audit(
        db, "tag_created",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="tag", target_id=tag.id,
        request=request,
        metadata={"name": name, "category": payload.category},
    )
    return tag.model_dump()


@router.get("/leads/tags/summary")
async def tag_usage_summary(
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    library_db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(
        require_roles("admin", "owner", "compliance", "coach"),
    ),
):
    """Tag usage counts across the agency. Admin / leadership only.

    Returns every tag in the library joined with its lead-count, so the
    response always covers the full library even for tags that no lead
    is wearing yet (count=0). Sorted by count desc.
    """
    agency = get_agency_id()

    # Library is the spine — start with every tag the agency knows about.
    lib_cursor = library_db.tags.find(
        {"agency_id": agency}, {"_id": 0},
    )
    library = await lib_cursor.to_list(length=None)
    by_name = {t["name"]: t for t in library}

    # Aggregate counts off the leads collection. agency-wide intentionally:
    # this endpoint is leadership-only and the usage view is a roll-up tool.
    pipeline = [
        {"$match": {"tags": {"$exists": True, "$ne": []}}},
        {"$unwind": "$tags"},
        {"$group": {"_id": "$tags", "count": {"$sum": 1}}},
    ]
    counts = {}
    async for row in db.leads.aggregate(pipeline):
        counts[row["_id"]] = row["count"]

    # Merge — every library row gets a count, unknown tag names (legacy /
    # orphaned, library entry was deleted) get a synthetic row so they
    # still surface in the usage view.
    items = []
    for name, tag in by_name.items():
        items.append({**tag, "count": counts.get(name, 0)})
    for name, count in counts.items():
        if name not in by_name:
            items.append({
                "name": name,
                "label": name,
                "color": "#94a3b8",
                "category": "custom",
                "agency_id": agency,
                "count": count,
                "orphaned": True,
            })
    items.sort(key=lambda r: (-r["count"], r["label"]))
    return {"items": items}


# ── Per-lead apply / remove ───────────────────────────────────────────────

class TagApply(BaseModel):
    tag: str = Field(..., min_length=1, max_length=64)


def _lead_idor_or_403(doc: Optional[dict], current_user: dict) -> dict:
    """Same shape as leads_router._idor_or_403 — local copy so the tags
    router doesn't have to reach into another router's private helper."""
    if not doc:
        raise HTTPException(status_code=404, detail="Lead not found")
    from deps import FULL_AGENCY_SCOPE_ROLES
    role = current_user.get("role")
    if role in FULL_AGENCY_SCOPE_ROLES:
        return doc
    if doc.get("agent_id") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


@router.post("/leads/{lead_id}/tags", status_code=200)
async def add_tag_to_lead(
    lead_id: str,
    payload: TagApply,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    library_db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Append a tag to the lead.

    Normalizes the supplied string, validates it exists in the agency
    library (so leads can't grow a junk-tag long tail), and uses
    ``$addToSet`` so re-applying the same tag is a no-op rather than a
    duplicate-entry error.
    """
    name = normalize_tag_name(payload.tag)
    if not name:
        raise HTTPException(
            status_code=422,
            detail="Tag must contain at least one alphanumeric character.",
        )

    agency = get_agency_id()
    tag_doc = await library_db.tags.find_one(
        {"agency_id": agency, "name": name}, {"_id": 0},
    )
    if not tag_doc:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Tag '{name}' is not in the agency library. Add it via "
                "POST /api/tags first."
            ),
        )

    existing = safe_lead_load(await db.leads.find_one(
        {"id": lead_id},
        {"_id": 0, "id": 1, "agent_id": 1, "tags": 1},
    ))
    _lead_idor_or_403(existing, current_user)

    now_iso = datetime.now(timezone.utc).isoformat()
    # $addToSet on the raw collection (tags are not PHI; safe_lead_set
    # is a $set wrapper, not an $addToSet wrapper). Stamp updated_at via
    # the same update_one so we don't need a second write.
    await db.leads.update_one(
        {"id": lead_id},
        {
            "$addToSet": {"tags": name},
            "$set": {"updated_at": now_iso},
        },
    )

    await write_audit(
        db, "lead_tag_added",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="lead", target_id=lead_id,
        request=request,
        metadata={"tag": name},
    )

    fresh = safe_lead_load(await db.leads.find_one(
        {"id": lead_id}, {"_id": 0, "id": 1, "tags": 1},
    ))
    return {"lead_id": lead_id, "tags": fresh.get("tags") or []}


@router.delete("/leads/{lead_id}/tags/{tag}", status_code=200)
async def remove_tag_from_lead(
    lead_id: str,
    tag: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Remove a tag from the lead. No-op when the tag isn't applied."""
    name = normalize_tag_name(tag)
    if not name:
        raise HTTPException(status_code=422, detail="Invalid tag name.")

    existing = safe_lead_load(await db.leads.find_one(
        {"id": lead_id},
        {"_id": 0, "id": 1, "agent_id": 1, "tags": 1},
    ))
    _lead_idor_or_403(existing, current_user)

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.leads.update_one(
        {"id": lead_id},
        {
            "$pull": {"tags": name},
            "$set": {"updated_at": now_iso},
        },
    )

    await write_audit(
        db, "lead_tag_removed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="lead", target_id=lead_id,
        request=request,
        metadata={"tag": name},
    )

    fresh = safe_lead_load(await db.leads.find_one(
        {"id": lead_id}, {"_id": 0, "id": 1, "tags": 1},
    ))
    return {"lead_id": lead_id, "tags": fresh.get("tags") or []}
