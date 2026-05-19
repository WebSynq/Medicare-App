"""GoHighLevel API v2 client (Private Integration Token auth).

When GHL_PRIVATE_TOKEN is empty, runs in MOCK mode for MVP/demo without breaking flows.
"""
import os
from typing import Dict, Any, List, Optional
import httpx


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
