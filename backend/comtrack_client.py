"""
comtrack_client.py
------------------
Mock-aware Comtrack API client.
Pattern mirrors ghl_client.py: empty COMTRACK_API_KEY → mock mode.
COMTRACK_API_KEY lives in backend/.env only — never exposed to frontend.
"""

import logging
import os
from datetime import datetime, timezone
from uuid import uuid4

import httpx

logger = logging.getLogger(__name__)

# ── Mock data ─────────────────────────────────────────────────────────────────
_MOCK_ROWS = [
    {
        "id": "mock-row-001",
        "agent_name": "Demo Agent",
        "carrier": "Aetna",
        "client_full_name": "John Sample",
        "policy_number": "MOCK-001",
        "effective_date": "01/01/2024",
        "termination_date": "",
        "plan": "Medicare Supplement Plan G",
        "plan_type": "MSPL",
        "member_state": "TX",
        "premium": "121.17",
        "comp_rate": "0.23",
        "commission": 278.69,
        "statement_date": "04/01/2025",
        "payment_period": "April 2025",
        "classification": "Renewal",
        "commission_action": "Commission",
    },
    {
        "id": "mock-row-002",
        "agent_name": "Demo Agent",
        "carrier": "UnitedHealthcare",
        "client_full_name": "Mary Example",
        "policy_number": "MOCK-002",
        "effective_date": "03/01/2023",
        "termination_date": "",
        "plan": "Medicare Advantage MAPD",
        "plan_type": "MAPD",
        "member_state": "TX",
        "premium": "0.00",
        "comp_rate": "0.00",
        "commission": 601.00,
        "statement_date": "04/01/2025",
        "payment_period": "April 2025",
        "classification": "Renewal",
        "commission_action": "Commission",
    },
    {
        "id": "mock-row-003",
        "agent_name": "Demo Agent",
        "carrier": "Humana",
        "client_full_name": "Robert Test",
        "policy_number": "MOCK-003",
        "effective_date": "01/01/2025",
        "termination_date": "",
        "plan": "Medicare Advantage MAPD",
        "plan_type": "MAPD",
        "member_state": "IL",
        "premium": "0.00",
        "comp_rate": "0.00",
        "commission": 601.00,
        "statement_date": "04/01/2025",
        "payment_period": "April 2025",
        "classification": "New",
        "commission_action": "Commission",
    },
    {
        "id": "mock-row-004",
        "agent_name": "Demo Agent",
        "carrier": "Mutual of Omaha",
        "client_full_name": "Susan Demo",
        "policy_number": "MOCK-004",
        "effective_date": "06/01/2022",
        "termination_date": "03/01/2025",
        "termination_reason": "Lapsed",
        "plan": "Medicare Supplement Plan N",
        "plan_type": "MSPL",
        "member_state": "AZ",
        "premium": "98.50",
        "comp_rate": "0.20",
        "commission": 197.00,
        "statement_date": "03/01/2025",
        "payment_period": "March 2025",
        "classification": "Renewal",
        "commission_action": "Commission",
    },
]


def _parse_statement_date(row: dict) -> datetime:
    """Parse statement_date (MM/DD/YYYY) for sorting. Returns datetime.min on failure."""
    try:
        return datetime.strptime(row.get("statement_date", ""), "%m/%d/%Y")
    except (ValueError, TypeError):
        return datetime.min


class ComtrackClient:
    """
    Async Comtrack API client.
    When COMTRACK_API_KEY is empty → mock mode (no external calls made).
    """

    BASE_URL = "https://commissionconnector.com/api"
    TIMEOUT = 30.0
    DIGEST_TIMEOUT = 60.0  # file uploads need more time

    def __init__(self) -> None:
        self.api_key = os.getenv("COMTRACK_API_KEY", "").strip()
        self.mock = not bool(self.api_key)
        if self.mock:
            logger.warning(
                "ComtrackClient running in MOCK mode — set COMTRACK_API_KEY to enable live data."
            )

    def _headers(self) -> dict:
        # ⚠️ SECURITY NOTE: api_key comes from env only, never from request params
        return {"x-api-key": self.api_key}

    # ── Digest ────────────────────────────────────────────────────────────────

    async def digest_file(
        self, file_content: bytes, filename: str, content_type: str
    ) -> dict:
        """
        Upload a carrier statement file to Comtrack for parsing.
        Returns: {"status": str, "file": {"id": str, "name": str}, "mock": bool}
        """
        if self.mock:
            return {
                "status": "digested",
                "file": {"id": str(uuid4()), "name": filename},
                "mock": True,
            }

        async with httpx.AsyncClient(timeout=self.DIGEST_TIMEOUT) as client:
            files = {"file": (filename, file_content, content_type)}
            try:
                resp = await client.post(
                    f"{self.BASE_URL}/digest",
                    headers=self._headers(),
                    files=files,
                )
                resp.raise_for_status()
                result = resp.json()
                result["mock"] = False
                return result
            except httpx.HTTPStatusError as exc:
                logger.error(
                    "Comtrack digest HTTP error %s: %s",
                    exc.response.status_code,
                    exc.response.text[:500],
                )
                raise
            except httpx.RequestError as exc:
                logger.error("Comtrack digest connection error: %s", exc)
                raise

    # ── Reference (list) ─────────────────────────────────────────────────────

    async def get_rows(self, agent_name: str) -> list[dict]:
        """
        Fetch all commission rows for a given agent name.
        Returns an empty list if no records found.
        """
        if self.mock:
            rows = [dict(r) for r in _MOCK_ROWS]
            for r in rows:
                r["agent_name"] = agent_name
            return rows

        async with httpx.AsyncClient(timeout=self.TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{self.BASE_URL}/reference",
                    headers=self._headers(),
                    params={"agent_name": agent_name},
                )
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as exc:
                logger.error(
                    "Comtrack reference HTTP error %s: %s",
                    exc.response.status_code,
                    exc.response.text[:500],
                )
                raise
            except httpx.RequestError as exc:
                logger.error("Comtrack reference connection error: %s", exc)
                raise

            if isinstance(data, list):
                return data
            if isinstance(data, dict) and data.get("message") == "No records found":
                return []
            if isinstance(data, dict):
                return [data]
            return []

    # ── Summary (aggregated) ─────────────────────────────────────────────────

    async def get_summary(self, agent_name: str) -> dict:
        """
        Aggregate commission rows into dashboard stats.
        Always returns a valid dict — never raises unless the underlying get_rows call fails.
        """
        rows = await self.get_rows(agent_name)

        if not rows:
            return {
                "ytd_commission": 0.0,
                "active_policies": 0,
                "last_paid_amount": 0.0,
                "last_paid_carrier": None,
                "last_paid_date": None,
                "total_rows": 0,
                "mock": self.mock,
            }

        # Active = no termination date
        active = [r for r in rows if not r.get("termination_date", "").strip()]

        # YTD — sum all commissions (commission field can be int, float, or str)
        ytd = 0.0
        for r in rows:
            try:
                ytd += float(r.get("commission") or 0)
            except (TypeError, ValueError):
                pass

        # Most recent by statement_date
        sorted_rows = sorted(rows, key=_parse_statement_date, reverse=True)
        latest = sorted_rows[0] if sorted_rows else {}

        last_paid_amount = 0.0
        try:
            last_paid_amount = float(latest.get("commission") or 0)
        except (TypeError, ValueError):
            pass

        return {
            "ytd_commission": round(ytd, 2),
            "active_policies": len(active),
            "last_paid_amount": round(last_paid_amount, 2),
            "last_paid_carrier": latest.get("carrier"),
            "last_paid_date": latest.get("statement_date"),
            "total_rows": len(rows),
            "mock": self.mock,
        }
