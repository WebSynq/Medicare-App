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
from deps import get_db, get_current_user, get_optional_user, write_audit


router = APIRouter(prefix="/documents", tags=["documents"])

STORAGE = Path(os.environ.get("DOC_STORAGE_PATH", "/app/backend/secure_storage"))
STORAGE.mkdir(parents=True, exist_ok=True)

MAX_BYTES = 15 * 1024 * 1024  # 15 MB cap
ALLOWED_TYPES = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "application/pdf",
}


@router.post("/upload/{lead_id}", response_model=DocumentMeta, status_code=201)
async def upload_document(
    lead_id: str,
    request: Request,
    file: UploadFile = File(...),
    doc_type: str = Form("other"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: Optional[dict] = Depends(get_optional_user),
):
    """Optional auth — if an agent is logged in, capture their identity on the
    upload + audit record. Anonymous beneficiary uploads during public intake
    are still accepted."""
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0, "id": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {file.content_type}")

    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 15MB)")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    doc_id = str(uuid.uuid4())
    encrypted = encrypt_bytes(contents)
    lead_dir = STORAGE / lead_id
    lead_dir.mkdir(parents=True, exist_ok=True)
    (lead_dir / f"{doc_id}.enc").write_bytes(encrypted)

    meta = {
        "id": doc_id,
        "lead_id": lead_id,
        "filename": file.filename or f"{doc_id}",
        "content_type": file.content_type,
        "size_bytes": len(contents),
        "doc_type": doc_type,
        "encrypted": True,
        "uploaded_by": current_user.get("id") if current_user else None,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.documents.insert_one(meta.copy())
    await db.leads.update_one({"id": lead_id}, {"$push": {"document_ids": doc_id},
                                                  "$set": {"updated_at": meta["uploaded_at"]}})
    await write_audit(
        db, "doc_uploaded",
        actor_email=current_user.get("email") if current_user else "anonymous (intake)",
        actor_id=current_user.get("id") if current_user else None,
        target_type="document", target_id=doc_id,
        request=request,
        metadata={"lead_id": lead_id, "doc_type": doc_type, "size": len(contents)},
    )
    return DocumentMeta(**meta)


@router.get("/by-lead/{lead_id}", response_model=List[DocumentMeta])
async def list_lead_documents(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    cursor = db.documents.find({"lead_id": lead_id}, {"_id": 0}).sort("uploaded_at", -1)
    return [DocumentMeta(**doc) async for doc in cursor]


@router.get("/{doc_id}/download")
async def download_document(
    doc_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    meta = await db.documents.find_one({"id": doc_id}, {"_id": 0})
    if not meta:
        raise HTTPException(status_code=404, detail="Document not found")
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
