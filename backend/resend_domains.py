"""Resend domain API — per-agency sending domain management.

Wraps the four Resend HTTP calls we need:
  POST   /domains              → add_domain
  GET    /domains/{id}         → get_domain (returns DNS records +
                                  verification status)
  POST   /domains/{id}/verify  → verify_domain (poll-style — Resend
                                  checks the DNS records)
  DELETE /domains/{id}         → delete_domain

All helpers never raise — they return a structured dict with at
least ``{"ok": bool, "error": str|None, ...}``. The router translates
``ok=False`` into a 502 or 400 depending on the failure mode.

Resend's pricing model includes DKIM + SPF + DMARC records per
domain. We expose those records verbatim to the agency owner so they
can paste them into their registrar — no DNS hosting required on our
side.

Security
========
- Reads RESEND_API_KEY at call time (env rotation safe).
- Returns 503-equivalent ``ok=False, error="not_configured"`` when
  the key is unset, so test envs short-circuit instead of throwing.
- Never logs the API key; never echoes it to any response.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx


logger = logging.getLogger(__name__)


_RESEND_BASE = "https://api.resend.com"
_TIMEOUT_SEC = 12.0


def _api_key() -> str:
    return (os.environ.get("RESEND_API_KEY") or "").strip()


def _headers(key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _err(msg: str, **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"ok": False, "error": msg}
    out.update(extra)
    return out


def _ok(**extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"ok": True, "error": None}
    out.update(extra)
    return out


# ── Public helpers ────────────────────────────────────────────────────
async def add_domain(domain: str,
                      region: str = "us-east-1") -> Dict[str, Any]:
    """Register a domain with Resend. Returns:

        {"ok": True, "domain_id": str, "name": str,
         "status": "not_started"|"pending"|"verified"|"failed",
         "records": [{"type": "TXT"|"MX"|"CNAME", ...}, ...]}

    on success. Resend echoes the DNS records the owner must add at
    their registrar — we hand them straight through to the SPA.
    """
    key = _api_key()
    if not key:
        return _err("not_configured")
    if not domain:
        return _err("invalid_domain")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
            r = await client.post(
                f"{_RESEND_BASE}/domains",
                headers=_headers(key),
                json={"name": domain, "region": region},
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("resend domains.add network error: %s", e)
        return _err("network", detail=str(e)[:200])

    if r.status_code in (200, 201):
        data = r.json() if r.text else {}
        return _ok(
            domain_id=data.get("id"),
            name=data.get("name") or domain,
            status=data.get("status") or "pending",
            region=data.get("region") or region,
            records=_normalise_records(data.get("records") or []),
        )
    body = _safe_json(r)
    msg = (body or {}).get("message") or f"http_{r.status_code}"
    logger.warning("resend domains.add http=%s body=%s",
                    r.status_code, str(body)[:200])
    return _err(msg, status_code=r.status_code)


async def get_domain(domain_id: str) -> Dict[str, Any]:
    """Read a domain record. Use this AFTER add_domain to refresh
    verification status (Resend updates the row when DNS resolves)."""
    key = _api_key()
    if not key:
        return _err("not_configured")
    if not domain_id:
        return _err("invalid_id")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
            r = await client.get(
                f"{_RESEND_BASE}/domains/{domain_id}",
                headers=_headers(key),
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("resend domains.get network error: %s", e)
        return _err("network", detail=str(e)[:200])
    if r.status_code == 404:
        return _err("not_found", status_code=404)
    if r.status_code == 200:
        data = r.json() if r.text else {}
        return _ok(
            domain_id=data.get("id"),
            name=data.get("name"),
            status=data.get("status"),
            region=data.get("region"),
            records=_normalise_records(data.get("records") or []),
        )
    body = _safe_json(r)
    msg = (body or {}).get("message") or f"http_{r.status_code}"
    logger.warning("resend domains.get http=%s body=%s",
                    r.status_code, str(body)[:200])
    return _err(msg, status_code=r.status_code)


async def verify_domain(domain_id: str) -> Dict[str, Any]:
    """Ask Resend to re-check the DNS records. The response carries
    the current verification status; callers should treat
    ``status == "verified"`` as the green light to start sending."""
    key = _api_key()
    if not key:
        return _err("not_configured")
    if not domain_id:
        return _err("invalid_id")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
            r = await client.post(
                f"{_RESEND_BASE}/domains/{domain_id}/verify",
                headers=_headers(key),
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("resend domains.verify network error: %s", e)
        return _err("network", detail=str(e)[:200])
    if r.status_code in (200, 202):
        data = r.json() if r.text else {}
        return _ok(
            domain_id=data.get("id") or domain_id,
            status=data.get("status") or "pending",
            records=_normalise_records(data.get("records") or []),
        )
    body = _safe_json(r)
    msg = (body or {}).get("message") or f"http_{r.status_code}"
    logger.warning("resend domains.verify http=%s body=%s",
                    r.status_code, str(body)[:200])
    return _err(msg, status_code=r.status_code)


async def delete_domain(domain_id: str) -> Dict[str, Any]:
    """Remove a domain from Resend. Idempotent — Resend returns 404
    when the id was already gone, which we treat as success."""
    key = _api_key()
    if not key:
        return _err("not_configured")
    if not domain_id:
        return _err("invalid_id")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
            r = await client.delete(
                f"{_RESEND_BASE}/domains/{domain_id}",
                headers=_headers(key),
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("resend domains.delete network error: %s", e)
        return _err("network", detail=str(e)[:200])
    if r.status_code in (200, 204, 404):
        return _ok(domain_id=domain_id, deleted=True)
    body = _safe_json(r)
    msg = (body or {}).get("message") or f"http_{r.status_code}"
    logger.warning("resend domains.delete http=%s body=%s",
                    r.status_code, str(body)[:200])
    return _err(msg, status_code=r.status_code)


# ── Helpers ────────────────────────────────────────────────────────────
def _safe_json(r) -> Optional[dict]:
    try:
        return r.json()
    except Exception:
        return None


def _normalise_records(raw: List[dict]) -> List[Dict[str, Any]]:
    """Resend returns DNS records in a slightly inconsistent shape
    across endpoints. Normalise to a single ``{type, name, value,
    status, ttl}`` shape so the SPA can render a single table."""
    out: List[Dict[str, Any]] = []
    for r in raw or []:
        if not isinstance(r, dict):
            continue
        out.append({
            "type": (r.get("record") or r.get("type") or "").upper(),
            "name": r.get("name") or r.get("host") or "",
            "value": r.get("value") or r.get("data") or "",
            "status": r.get("status") or "",
            "ttl": r.get("ttl") or "Auto",
            "priority": r.get("priority"),
        })
    return out
