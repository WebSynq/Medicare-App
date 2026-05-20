"""GoHighLevel API v2 client (Private Integration Token auth).

When GHL_PRIVATE_TOKEN is empty, runs in MOCK mode for MVP/demo without breaking flows.
"""
import asyncio
import logging
import os
from typing import Any, Callable, Dict, List, Optional

import httpx


logger = logging.getLogger("gruening.ghl")


# Default timeout for "safe" helper methods that promise to never throw.
# Longer than the original 15s because we may retry once on 429.
_SAFE_TIMEOUT = 30.0


async def _call_ghl(
    label: str,
    fn: Callable[[], Any],
    contact_id: Optional[str] = None,
) -> Optional[Any]:
    """Run a GHL call with one retry on 429 and never-throw semantics.

    ``fn`` is a callable that returns an awaitable (i.e. ``lambda:
    client.get(...)``). We retry exactly once after a short back-off
    when GHL returns 429 — that's enough to ride out the per-minute
    throttle without piling on if the rate-limit is sustained.

    Logs every call with the label, contact id (when available), and
    final HTTP status. Returns the parsed JSON body on success,
    ``None`` on any failure — callers gate their behaviour on the
    return value rather than expecting exceptions.
    """
    for attempt in (1, 2):
        try:
            resp = await fn()
        except httpx.HTTPError as e:
            logger.warning(
                "GHL %s transport error (attempt %d) contact=%s: %s",
                label, attempt, contact_id, e,
            )
            if attempt == 1:
                await asyncio.sleep(0.6)
                continue
            return None
        except Exception as e:
            logger.warning(
                "GHL %s unexpected error contact=%s: %s",
                label, contact_id, e,
            )
            return None

        status = getattr(resp, "status_code", None)
        if status == 429 and attempt == 1:
            logger.warning(
                "GHL %s rate-limited (429), retrying once contact=%s",
                label, contact_id,
            )
            await asyncio.sleep(1.2)
            continue
        if status is None or status >= 400:
            logger.warning(
                "GHL %s non-2xx contact=%s status=%s body=%s",
                label, contact_id, status,
                (resp.text or "")[:200] if hasattr(resp, "text") else "",
            )
            return None
        logger.info("GHL %s ok contact=%s status=%s", label, contact_id, status)
        try:
            return resp.json()
        except Exception:
            return {}


class GHLClient:
    def __init__(self):
        self.base_url = os.environ.get("GHL_BASE_URL", "https://services.leadconnectorhq.com").rstrip("/")
        self.token = os.environ.get("GHL_PRIVATE_TOKEN", "").strip()
        self.location_id = os.environ.get("GHL_LOCATION_ID", "").strip()
        self.pipeline_id = os.environ.get("GHL_PIPELINE_ID", "").strip()
        self.stage_id = os.environ.get("GHL_PIPELINE_STAGE_ID", "").strip()
        self.api_version = os.environ.get("GHL_API_VERSION", "2021-07-28")

    @property
    def mock_mode(self) -> bool:
        return not (self.token and self.location_id)

    def _headers(self, content_type: str = "application/json") -> Dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Version": self.api_version,
            "Accept": "application/json",
        }
        if content_type:
            h["Content-Type"] = content_type
        return h

    async def upsert_contact(self, lead: Dict[str, Any]) -> Dict[str, Any]:
        if self.mock_mode:
            return {"mock": True, "contact": {"id": f"mock_{lead.get('id', 'unknown')}"}}

        payload = {
            "locationId": self.location_id,
            "firstName": lead.get("first_name"),
            "lastName": lead.get("last_name"),
            "email": lead.get("email"),
            "phone": lead.get("phone"),
            "address1": lead.get("address_line1"),
            "city": lead.get("city"),
            "state": lead.get("state"),
            "postalCode": lead.get("zip_code"),
            "dateOfBirth": lead.get("date_of_birth"),
            "customFields": _build_custom_fields(lead),
            "tags": ["Medicare-Lead"],
        }
        payload = {k: v for k, v in payload.items() if v is not None}

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{self.base_url}/contacts/upsert",
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()

    async def add_tags(self, contact_id: str, tags: List[str]) -> Dict[str, Any]:
        if self.mock_mode:
            return {"mock": True, "added": tags}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{self.base_url}/contacts/{contact_id}/tags",
                headers=self._headers(),
                json={"tags": tags},
            )
            resp.raise_for_status()
            return resp.json()

    async def create_opportunity(self, contact_id: str, title: str,
                                 monetary_value: Optional[float] = None) -> Dict[str, Any]:
        if self.mock_mode or not self.pipeline_id:
            return {"mock": True, "opportunity": {"id": f"mock_opp_{contact_id}"}}
        payload = {
            "pipelineId": self.pipeline_id,
            "locationId": self.location_id,
            "name": title,
            "pipelineStageId": self.stage_id,
            "status": "open",
            "contactId": contact_id,
        }
        if monetary_value is not None:
            payload["monetaryValue"] = monetary_value
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{self.base_url}/opportunities/",
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()


    async def update_contact(self, contact_id: str, custom_fields) -> dict:
        if self.mock_mode:
            return {"mock": True, "updated": True, "contact_id": contact_id}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.put(
                f"{self.base_url}/contacts/{contact_id}",
                headers=self._headers(),
                json={"customFields": custom_fields},
            )
            resp.raise_for_status()
            return resp.json()

    # ── Hardened helpers (retry-on-429, never-throw) ─────────────────────
    # The methods below all use the _call_ghl wrapper so the bidirectional
    # sync paths in leads_router can call GHL without try/except clutter
    # at every callsite. They return None on any failure — callers gate
    # their downstream behaviour on the return value.

    async def create_contact(self, lead: Dict[str, Any]) -> Optional[str]:
        """Create (not upsert) a GHL contact from a portal lead. Returns
        the new GHL contact id, or None on failure / mock mode."""
        if self.mock_mode:
            return f"mock_{lead.get('id', 'unknown')}"
        if not self.location_id:
            logger.warning("GHL create_contact skipped — GHL_LOCATION_ID unset")
            return None
        payload = {
            "locationId": self.location_id,
            "firstName": lead.get("first_name"),
            "lastName": lead.get("last_name"),
            "email": lead.get("email"),
            "phone": lead.get("phone"),
            "address1": lead.get("address_line1"),
            "city": lead.get("city"),
            "state": lead.get("state"),
            "postalCode": lead.get("zip_code"),
            "dateOfBirth": lead.get("date_of_birth"),
            "source": lead.get("lead_source") or lead.get("source"),
        }
        payload = {k: v for k, v in payload.items() if v}
        tags = []
        if lead.get("product_interest"):
            tags.append(lead["product_interest"])
        if lead.get("tags"):
            tags.extend([t for t in lead["tags"] if isinstance(t, str)])
        if tags:
            payload["tags"] = list(dict.fromkeys(tags))

        async def _do():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.post(
                    f"{self.base_url}/contacts/",
                    headers=self._headers(),
                    json=payload,
                )
        body = await _call_ghl("create_contact", _do)
        if not body:
            return None
        contact = body.get("contact") or body.get("data", {}).get("contact") or {}
        return contact.get("id")

    async def update_contact_fields(
        self,
        contact_id: str,
        fields: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """PUT arbitrary fields onto an existing GHL contact.

        Accepts portal-style ``snake_case`` keys (``first_name``,
        ``zip_code``, ``date_of_birth``…) plus pass-through camelCase
        and translates them. Returns the parsed response body on
        success, None on any failure.
        """
        if self.mock_mode:
            return {"mock": True, "updated": True, "contact_id": contact_id}
        if not contact_id:
            return None
        translation = {
            "first_name": "firstName",
            "last_name": "lastName",
            "address_line1": "address1",
            "zip_code": "postalCode",
            "date_of_birth": "dateOfBirth",
            "lead_source": "source",
        }
        payload: Dict[str, Any] = {}
        for k, v in fields.items():
            if v is None:
                continue
            payload[translation.get(k, k)] = v

        async def _do():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.put(
                    f"{self.base_url}/contacts/{contact_id}",
                    headers=self._headers(),
                    json=payload,
                )
        return await _call_ghl("update_contact_fields", _do, contact_id=contact_id)

    async def move_opportunity_stage(
        self,
        contact_id: str,
        stage_name: str,
    ) -> Optional[Dict[str, Any]]:
        """Move the contact's most recent opportunity into a pipeline stage.

        GHL's API doesn't allow updating by ``stageName`` directly — we
        have to resolve ``stage_name`` to a ``pipelineStageId`` for the
        configured pipeline first. If we can't find a matching stage
        (or no opportunity exists for the contact), the call is a
        no-op and returns None.

        Stage matching is case-insensitive on the configured pipeline's
        stage list. The pipeline is whatever ``GHL_PIPELINE_ID`` points
        at; in environments with multiple pipelines this method does
        nothing until that env var is set.
        """
        if self.mock_mode:
            return {"mock": True, "stage": stage_name}
        if not contact_id or not stage_name or not self.pipeline_id:
            return None

        # 1) Find the stage id by name on the configured pipeline.
        async def _fetch_pipeline():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.get(
                    f"{self.base_url}/opportunities/pipelines",
                    headers=self._headers(),
                    params={"locationId": self.location_id},
                )
        pipelines_resp = await _call_ghl("list_pipelines", _fetch_pipeline,
                                          contact_id=contact_id)
        if not pipelines_resp:
            return None
        target_stage_id: Optional[str] = None
        for p in (pipelines_resp.get("pipelines") or []):
            if p.get("id") != self.pipeline_id:
                continue
            for s in (p.get("stages") or []):
                if (s.get("name") or "").strip().lower() == stage_name.strip().lower():
                    target_stage_id = s.get("id")
                    break
        if not target_stage_id:
            logger.warning(
                "GHL stage %r not found on pipeline %s — skipping move",
                stage_name, self.pipeline_id,
            )
            return None

        # 2) Find the most recent opportunity for this contact.
        async def _fetch_opps():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.get(
                    f"{self.base_url}/opportunities/search",
                    headers=self._headers(),
                    params={
                        "location_id": self.location_id,
                        "contact_id": contact_id,
                        "pipeline_id": self.pipeline_id,
                        "limit": 1,
                    },
                )
        opps_resp = await _call_ghl("search_opportunities", _fetch_opps,
                                     contact_id=contact_id)
        if not opps_resp:
            return None
        opportunities = (opps_resp.get("opportunities") or [])
        if not opportunities:
            logger.info("GHL move_opportunity_stage: no opportunity for contact=%s", contact_id)
            return None
        opp_id = opportunities[0].get("id")
        if not opp_id:
            return None

        # 3) PUT the new stage id onto the opportunity.
        async def _do_update():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.put(
                    f"{self.base_url}/opportunities/{opp_id}",
                    headers=self._headers(),
                    json={"pipelineStageId": target_stage_id},
                )
        return await _call_ghl("update_opportunity_stage", _do_update,
                                contact_id=contact_id)

    async def get_contact(self, contact_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a single GHL contact by id. Returns the contact dict or
        None on miss / failure / mock mode."""
        if self.mock_mode or not contact_id:
            return None

        async def _do():
            async with httpx.AsyncClient(timeout=_SAFE_TIMEOUT) as client:
                return await client.get(
                    f"{self.base_url}/contacts/{contact_id}",
                    headers=self._headers(),
                )
        body = await _call_ghl("get_contact", _do, contact_id=contact_id)
        if not body:
            return None
        return body.get("contact") or body.get("data", {}).get("contact") or body

    async def list_contacts(
        self,
        limit: int = 100,
        start_after_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Pull the next page of contacts for this location.

        Used by the manual /api/ghl/sync endpoint. Page boundaries are
        controlled by ``startAfterId`` (the GHL v2 cursor) — pass the
        previous page's last contact id to walk past it. We return the
        raw list of contact dicts so the caller can decide how many to
        sync per invocation.
        """
        if self.mock_mode:
            return []
        params: Dict[str, Any] = {
            "locationId": self.location_id,
            "limit": limit,
        }
        if start_after_id:
            params["startAfterId"] = start_after_id
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.base_url}/contacts/",
                headers=self._headers(),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json() or {}
            return data.get("contacts", []) or []

    async def search_contacts(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        if self.mock_mode:
            return [
                {"id": "mock_contact_1", "firstName": "John", "lastName": "Smith",
                 "email": "john.smith@example.com"},
                {"id": "mock_contact_2", "firstName": "Jane", "lastName": "Doe",
                 "email": "jane.doe@example.com"},
            ]
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{self.base_url}/contacts/",
                headers=self._headers(),
                params={
                    "locationId": self.location_id,
                    "query": query,
                    "limit": limit,
                }
            )
            resp.raise_for_status()
            data = resp.json()
            # GHL v2 returns contacts under "contacts" key
            return data.get("contacts", [])

    async def search_contacts_by_name(self, name: str) -> List[Dict[str, Any]]:
        """Fallback search using name split into first/last."""
        if self.mock_mode:
            return []
        parts = name.strip().split()
        first = parts[0] if parts else name
        last = parts[-1] if len(parts) > 1 else ""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{self.base_url}/contacts/search/duplicate",
                headers=self._headers(),
                params={
                    "locationId": self.location_id,
                    "firstName": first,
                    "lastName": last,
                }
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                contact = data.get("contact")
                return [contact] if contact else []
            return []


def _build_custom_fields(lead: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Build GHL custom field array. Keys assume custom fields exist in the GHL location.
    Replace with actual custom field IDs from the location."""
    fields = []
    mapping = {
        # Medicare
        "mbi_number": "mbi_number",
        "medicare_part_a_effective": "medicare_part_a_effective",
        "medicare_part_b_effective": "medicare_part_b_effective",
        "current_carrier": "current_carrier",
        "current_plan": "current_plan",
        "soa_signed": "soa_signed",
        "preferred_contact_time": "preferred_contact_time",
        # Application details (GHW app sale submission)
        "sales_submitting_agent": "sales_submitting_agent",
        "agency_or_personal": "agency_or_personal",
        "new_or_current_client": "new_or_current_client",
        "number_of_apps": "number_of_apps",
        "replacement_app": "replacement_app",
        "lead_source": "lead_source",
        "plan_type_premium": "plan_type_premium",
        "underwriting_approved": "underwriting_approved",
        "cancel_old_plan": "cancel_old_plan",
        "admin_requests": "admin_requests",
    }
    for local_key, ghl_key in mapping.items():
        val = lead.get(local_key)
        if val is None or val == "":
            continue
        fields.append({"key": ghl_key, "field_value": str(val)})

    if lead.get("doctors"):
        fields.append({"key": "doctors", "field_value": ", ".join(lead["doctors"])})
    if lead.get("prescriptions"):
        fields.append({"key": "prescriptions", "field_value": ", ".join(lead["prescriptions"])})
    return fields
