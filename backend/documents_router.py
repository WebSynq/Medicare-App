"""Document upload/download with encryption-at-rest (Fernet)."""
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import DocumentMeta
from security import encrypt_bytes, decrypt_bytes
from deps import (
    get_db,
    get_phi_db,
    get_current_user,
    get_effective_agent,
    agent_filter,
    write_audit,
)
from encryption import safe_lead_set, safe_lead_load


router = APIRouter(prefix="/documents", tags=["documents"])

STORAGE = Path(os.environ.get("DOC_STORAGE_PATH", "/app/backend/secure_storage"))
STORAGE.mkdir(parents=True, exist_ok=True)

MAX_BYTES = 10 * 1024 * 1024  # 10 MB hard cap (was 15MB — tightened post pen-test)
ALLOWED_TYPES = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "application/pdf",
}

# Magic-byte signatures used to validate that the uploaded bytes match
# the declared content-type. A polymorphic file (e.g. a PDF renamed to
# image.jpg) is rejected here even though the previous content-type
# allowlist would have passed it.
_MAGIC_BYTES = {
    "application/pdf": (b"%PDF",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/jpg": (b"\xff\xd8\xff",),
    # WEBP files start with "RIFF????WEBP". We require RIFF at byte 0
    # and don't enforce the WEBP magic at offset 8 here — the size
    # cap + content-type allowlist is the practical bound.
    "image/webp": (b"RIFF",),
}


def _validate_magic_bytes(content_type: str, body: bytes) -> bool:
    """Return True when ``body`` starts with one of the known magic
    sequences for ``content_type``. Defaults open (True) for any type
    not present in the table — but the route's allowlist already
    constrains content_type to entries we've encoded above."""
    sigs = _MAGIC_BYTES.get((content_type or "").lower())
    if not sigs:
        return True
    return any(body.startswith(sig) for sig in sigs)


def _idor_or_403(doc: Optional[dict], current_user: dict, kind: str) -> dict:
    """Phase 2 ownership check. 404 if doc doesn't exist, 403 if it exists
    but the caller isn't admin/compliance and doesn't own it."""
    if not doc:
        raise HTTPException(status_code=404, detail=f"{kind} not found")
    role = current_user.get("role")
    if role in ("admin", "compliance"):
        return doc
    if doc.get("agent_id") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


@router.post("/upload/{lead_id}", response_model=DocumentMeta, status_code=201)
async def upload_document(
    lead_id: str,
    request: Request,
    file: UploadFile = File(...),
    doc_type: str = Form("other"),
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
):
    """Encrypt and persist a document attached to a lead.

    Auth required. Agents may only upload to leads they own (verified via
    the Phase 2 IDOR check on the lead). Admin / compliance may upload to
    any lead. Anonymous uploads were previously accepted, which let any
    caller stash arbitrary content (potentially malicious or PHI-laden)
    against a known lead_id.
    """
    lead = safe_lead_load(await db.leads.find_one({"id": lead_id}, {"_id": 0, "id": 1, "agent_id": 1}))
    _idor_or_403(lead, current_user, "Lead")

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {file.content_type}")

    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10MB)")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    # Reject files whose magic bytes don't match the declared
    # content-type — a fake .pdf with a JPEG payload (or vice versa)
    # is a classic file-upload pivot. Caps + allowlist alone don't
    # catch this.
    if not _validate_magic_bytes(file.content_type, contents):
        raise HTTPException(
            status_code=415,
            detail=(
                f"File contents do not match the declared type "
                f"({file.content_type})."
            ),
        )

    doc_id = str(uuid.uuid4())
    encrypted = encrypt_bytes(contents)
    lead_dir = STORAGE / lead_id
    lead_dir.mkdir(parents=True, exist_ok=True)
    (lead_dir / f"{doc_id}.enc").write_bytes(encrypted)

    # Stamp ownership from the effective agent (respects admin/compliance
    # impersonation via X-Agent-ID).
    agent_id = effective["id"]
    agent_email = (effective.get("email") or "").lower().strip() or None

    meta = {
        "id": doc_id,
        "lead_id": lead_id,
        "filename": file.filename or f"{doc_id}",
        "content_type": file.content_type,
        "size_bytes": len(contents),
        "doc_type": doc_type,
        "encrypted": True,
        "uploaded_by": current_user.get("id"),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
        "agent_email": agent_email,
    }
    await db.documents.insert_one(meta.copy())
    await db.leads.update_one({"id": lead_id}, {"$push": {"document_ids": doc_id},
                                                  "$set": safe_lead_set({"updated_at": meta["uploaded_at"]})})
    await write_audit(
        db, "doc_uploaded",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="document", target_id=doc_id,
        request=request,
        metadata={"lead_id": lead_id, "doc_type": doc_type, "size": len(contents),
                   "agent_id": agent_id,
                   "impersonated_by": effective.get("_impersonated_by")},
    )
    return DocumentMeta(**meta)


@router.get("/by-lead/{lead_id}", response_model=List[DocumentMeta])
async def list_lead_documents(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List docs for a lead. Phase 2 scoping: agents see only the docs
    they (or impersonated them) uploaded; admin/compliance see everything."""
    query = {"lead_id": lead_id, **agent_filter(current_user)}
    cursor = db.documents.find(query, {"_id": 0}).sort("uploaded_at", -1)
    return [DocumentMeta(**doc) async for doc in cursor]


@router.get("/{doc_id}/download")
async def download_document(
    doc_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    meta = await db.documents.find_one({"id": doc_id}, {"_id": 0})
    meta = _idor_or_403(meta, current_user, "Document")

    # S3-backed docs (e.g. application PDFs written by application_router
    # at submit time) are stored externally — redirect to the s3_url
    # rather than trying to read local-disk ciphertext that was never
    # written. The audit row is still stamped so the trail is intact
    # whether the bytes streamed from S3 or local storage.
    if meta.get("storage_type") == "s3" and meta.get("s3_url"):
        await write_audit(
            db, "doc_downloaded",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            target_type="document", target_id=doc_id,
            request=request,
            metadata={"lead_id": meta.get("lead_id"), "source": "s3"},
        )
        from fastapi.responses import RedirectResponse
        # 307 preserves the method and isn't cached — safe for the
        # one-shot download the SPA initiates from the Documents tab.
        return RedirectResponse(url=meta["s3_url"], status_code=307)

    # Local-disk path (the original encrypt-then-stream behaviour).
    path = STORAGE / meta["lead_id"] / f"{doc_id}.enc"
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on storage")
    decrypted = decrypt_bytes(path.read_bytes())
    await write_audit(db, "doc_downloaded", actor_email=current_user["email"],
                      actor_id=current_user["id"], target_type="document", target_id=doc_id,
                      request=request, metadata={"lead_id": meta["lead_id"]})

    import io
    return StreamingResponse(
        io.BytesIO(decrypted),
        media_type=meta["content_type"],
        headers={"Content-Disposition": f'attachment; filename="{meta["filename"]}"'},
    )
