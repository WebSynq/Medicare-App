"""Policy lookup + PDF download endpoints.

Lives in its own module so the URL space is ``/api/policies/{id}/pdf``
rather than ``/api/applications/policies/{id}/pdf``. Reuses the S3
client + bucket from ``application_router`` so we don't duplicate the
boto3 setup.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from deps import agent_filter, get_current_user, get_db, write_audit
from application_router import (
    AWS_REGION,
    S3_BUCKET,
    _get_s3_client,
)


logger = logging.getLogger("gruening.policies")
router = APIRouter(prefix="/policies", tags=["policies"])


@router.get("/{policy_id}/pdf")
async def get_policy_pdf_url(
    policy_id: str,
    request: Request,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Mint a presigned S3 URL for the policy PDF.

    Expiry is 5 minutes — minimal exposure window per the post-pentest
    hardening. URL is returned as JSON; the frontend opens it in a new
    tab so the redirect happens client-side with the same expiry clock.

    Agent-scoped via ``agent_filter`` so an agent can only sign URLs
    for policies on their own book; admin / compliance see everything.
    Falls back to the unsigned ``s3_url`` / ``pdf_url`` fields on the
    policy doc when no ``s3_key`` is stored (older rows).
    """
    scope = agent_filter(current_user)
    match: dict = {"policy_id": policy_id, **scope}
    policy = await db["policies"].find_one(match, {"_id": 0})
    if not policy:
        match = {"id": policy_id, **scope}
        policy = await db["policies"].find_one(match, {"_id": 0})
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    s3_key = policy.get("s3_key") or ""
    if not s3_key or not S3_BUCKET:
        url = policy.get("s3_url") or policy.get("pdf_url")
        if not url:
            raise HTTPException(status_code=404, detail="No PDF on file")
        return {"url": url, "expires_in": 0, "presigned": False}

    try:
        s3 = _get_s3_client()
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": s3_key},
            ExpiresIn=300,  # 5 minutes — per post-pentest hardening
        )
    except Exception as e:
        logger.warning("Presign failed for policy %s: %s", policy_id, e)
        raise HTTPException(status_code=502, detail="Could not sign PDF URL")

    await write_audit(
        db, "policy_pdf_presigned",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="policy", target_id=policy_id,
        request=request,
        metadata={"s3_key": s3_key, "expires_in": 300, "region": AWS_REGION},
    )
    return {"url": url, "expires_in": 300, "presigned": True}
