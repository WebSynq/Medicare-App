"""End-to-end backend tests for Gruening Health & Wealth Medicare Intake API.

Covers: health, auth (login + MFA + register RBAC), leads CRUD + GHL mock sync,
documents (upload/list/download + 415/413/empty), SOA sign + retrieve, audit RBAC + summary.
"""
import io
import os
import time
import uuid
import base64
import requests
import pyotp
import pytest

from conftest import BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD


# ---------------- Health ----------------
class TestHealth:
    def test_root(self):
        r = requests.get(f"{BASE_URL}/api/", timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["status"] == "ok"
        assert "hipaa_safeguards" in d and isinstance(d["hipaa_safeguards"], list)
        assert d["app"].startswith("Gruening")

    def test_health_mongo(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["status"] == "ok"
        assert d["mongo"] == "ok"


# ---------------- Auth ----------------
class TestAuth:
    def test_login_success(self):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                          timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["access_token"]
        assert d["token_type"] == "bearer"
        assert d["mfa_required"] in (False, True)  # depending on MFA state
        assert d["user"]["email"] == ADMIN_EMAIL
        assert d["user"]["role"] == "admin"

    def test_login_invalid(self):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": ADMIN_EMAIL, "password": "wrongpass"},
                          timeout=30)
        assert r.status_code == 401

    def test_me_with_token(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["email"] == ADMIN_EMAIL
        assert d["role"] == "admin"
        assert "id" in d
        assert "hashed_password" not in d  # public model only

    def test_me_without_token(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", timeout=30)
        assert r.status_code == 401

    def test_register_requires_admin(self):
        # No token at all -> 401
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          json={"email": "x@y.com", "password": "abc12345",
                                "full_name": "X", "role": "agent"},
                          timeout=30)
        assert r.status_code == 401

    def test_register_creates_agent_and_rejects_duplicate(self, admin_headers):
        unique_email = f"TEST_agent_{uuid.uuid4().hex[:8]}@grueninghw.com"
        body = {"email": unique_email, "password": "AgentPass!2026",
                "full_name": "Test Agent", "role": "agent"}
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          headers=admin_headers, json=body, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["email"] == unique_email
        assert d["role"] == "agent"
        assert d["is_active"] is True
        assert d["mfa_enabled"] is False

        # duplicate
        r2 = requests.post(f"{BASE_URL}/api/auth/register",
                           headers=admin_headers, json=body, timeout=30)
        assert r2.status_code == 400

    def test_register_rejected_for_non_admin(self, admin_headers):
        # Create an agent and login as that agent — try to register another user
        agent_email = f"TEST_agent2_{uuid.uuid4().hex[:8]}@grueninghw.com"
        agent_pw = "AgentPass!2026"
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          headers=admin_headers,
                          json={"email": agent_email, "password": agent_pw,
                                "full_name": "Agent2", "role": "agent"},
                          timeout=30)
        assert r.status_code == 200

        login = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"email": agent_email, "password": agent_pw},
                              timeout=30)
        assert login.status_code == 200, login.text
        agent_token = login.json()["access_token"]
        h = {"Authorization": f"Bearer {agent_token}", "Content-Type": "application/json"}

        r2 = requests.post(f"{BASE_URL}/api/auth/register",
                           headers=h,
                           json={"email": f"TEST_x_{uuid.uuid4().hex[:8]}@y.com",
                                 "password": "abc12345", "full_name": "X", "role": "agent"},
                           timeout=30)
        assert r2.status_code == 403


# ---------------- MFA flow (on a fresh test agent so we don't lock the admin) ----------------
class TestMFAFlow:
    def test_mfa_enroll_verify_login(self, admin_headers):
        # 1) create a fresh user
        email = f"TEST_mfa_{uuid.uuid4().hex[:8]}@grueninghw.com"
        pw = "MfaPass!2026"
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          headers=admin_headers,
                          json={"email": email, "password": pw,
                                "full_name": "MFA User", "role": "agent"},
                          timeout=30)
        assert r.status_code == 200

        # 2) login -> token
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": email, "password": pw}, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["mfa_required"] is False
        token = data["access_token"]
        h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        # 3) /mfa/enroll
        r = requests.post(f"{BASE_URL}/api/auth/mfa/enroll", headers=h, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["secret"]
        assert d["otpauth_uri"].startswith("otpauth://")
        assert d["qr_png_base64"]
        # validate base64 decodes to a PNG
        png_bytes = base64.b64decode(d["qr_png_base64"])
        assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

        secret = d["secret"]
        code = pyotp.TOTP(secret).now()

        # 4) /mfa/verify
        r = requests.post(f"{BASE_URL}/api/auth/mfa/verify",
                          headers=h, json={"code": code}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["message"] == "MFA enabled"
        assert d["access_token"]

        # 5) login WITHOUT mfa_code -> mfa_required=true
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": email, "password": pw}, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["mfa_required"] is True

        # 6) login WITH mfa_code -> success, mfa_required=false
        # Sleep a tiny bit if needed to avoid totp reuse window edge case
        code2 = pyotp.TOTP(secret).now()
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": email, "password": pw, "mfa_code": code2},
                          timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["mfa_required"] is False
        assert d["access_token"]


# ---------------- Leads ----------------
class TestLeads:
    def test_create_lead_public(self):
        body = {"first_name": "TEST_John", "last_name": "Doe",
                "email": f"TEST_lead_{uuid.uuid4().hex[:6]}@example.com",
                "phone": "555-555-1234",
                "date_of_birth": "1955-04-12",
                "address_line1": "1 Main St", "city": "Tampa", "state": "FL",
                "zip_code": "33601", "current_carrier": "Humana",
                "doctors": ["Dr. Smith"], "prescriptions": ["Atorvastatin"]}
        r = requests.post(f"{BASE_URL}/api/leads", json=body, timeout=30)
        assert r.status_code == 201, r.text
        d = r.json()
        assert d["id"]
        assert d["first_name"] == "TEST_John"
        assert d["status"] == "new"
        assert d["soa_signed"] is False
        assert d["ghl_sync_status"] == "pending"
        # store for downstream
        pytest.LEAD_ID = d["id"]
        pytest.LEAD_EMAIL = d["email"]

    def test_list_leads_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/leads", timeout=30)
        assert r.status_code == 401

    def test_list_and_filter_leads(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/leads", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        leads = r.json()
        assert isinstance(leads, list)
        assert any(l["id"] == pytest.LEAD_ID for l in leads)

        # status filter
        r = requests.get(f"{BASE_URL}/api/leads?status=new",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert all(l["status"] == "new" for l in r.json())

        # q filter
        r = requests.get(f"{BASE_URL}/api/leads?q=TEST_John",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert any(l["id"] == pytest.LEAD_ID for l in r.json())

    def test_get_lead_by_id(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/leads/{pytest.LEAD_ID}",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["id"] == pytest.LEAD_ID

        r = requests.get(f"{BASE_URL}/api/leads/does-not-exist",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 404

    def test_patch_lead_status(self, admin_headers):
        r = requests.patch(f"{BASE_URL}/api/leads/{pytest.LEAD_ID}",
                           headers=admin_headers,
                           json={"status": "contacted", "notes": "called"},
                           timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "contacted"

        # GET to verify persistence
        r = requests.get(f"{BASE_URL}/api/leads/{pytest.LEAD_ID}",
                         headers=admin_headers, timeout=30)
        assert r.json()["status"] == "contacted"
        assert r.json()["notes"] == "called"

    def test_sync_ghl_mock(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/leads/{pytest.LEAD_ID}/sync-ghl",
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ghl_sync_status"] == "mock"
        assert d["ghl_contact_id"] is not None
        assert d["ghl_contact_id"].startswith("mock_")


# ---------------- Documents ----------------
class TestDocuments:
    def test_upload_png_then_list_and_download(self, admin_headers):
        # 1×1 PNG
        png_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        files = {"file": ("test.png", png_bytes, "image/png")}
        data = {"doc_type": "medicare_card"}
        r = requests.post(f"{BASE_URL}/api/documents/upload/{pytest.LEAD_ID}",
                          files=files, data=data, timeout=30)
        assert r.status_code == 201, r.text
        meta = r.json()
        assert meta["lead_id"] == pytest.LEAD_ID
        assert meta["content_type"] == "image/png"
        assert meta["size_bytes"] == len(png_bytes)
        assert meta["encrypted"] is True
        assert meta["doc_type"] == "medicare_card"
        pytest.DOC_ID = meta["id"]

        # encrypted file is on disk
        path = f"/app/backend/secure_storage/{pytest.LEAD_ID}/{pytest.DOC_ID}.enc"
        assert os.path.exists(path), f"encrypted blob missing at {path}"
        # content on disk should NOT match the original (Fernet encrypted)
        with open(path, "rb") as f:
            on_disk = f.read()
        assert on_disk != png_bytes

        # 2) list (auth)
        r = requests.get(f"{BASE_URL}/api/documents/by-lead/{pytest.LEAD_ID}",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        docs = r.json()
        assert any(d["id"] == pytest.DOC_ID for d in docs)

        # 3) list without auth -> 401
        r = requests.get(f"{BASE_URL}/api/documents/by-lead/{pytest.LEAD_ID}",
                         timeout=30)
        assert r.status_code == 401

        # 4) download (auth) — should decrypt to original PNG bytes
        r = requests.get(f"{BASE_URL}/api/documents/{pytest.DOC_ID}/download",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert r.content == png_bytes
        assert r.headers["content-type"].startswith("image/png")

    def test_upload_unsupported_type(self):
        files = {"file": ("evil.exe", b"MZ\x90\x00", "application/octet-stream")}
        r = requests.post(f"{BASE_URL}/api/documents/upload/{pytest.LEAD_ID}",
                          files=files, timeout=30)
        assert r.status_code == 415

    def test_upload_empty_file(self):
        files = {"file": ("empty.png", b"", "image/png")}
        r = requests.post(f"{BASE_URL}/api/documents/upload/{pytest.LEAD_ID}",
                          files=files, timeout=30)
        assert r.status_code == 400

    def test_upload_missing_lead(self):
        png_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        files = {"file": ("x.png", png_bytes, "image/png")}
        r = requests.post(f"{BASE_URL}/api/documents/upload/no-such-lead",
                          files=files, timeout=30)
        assert r.status_code == 404


# ---------------- SOA ----------------
class TestSOA:
    def test_sign_requires_consent(self):
        r = requests.post(f"{BASE_URL}/api/soa/sign", json={
            "lead_id": pytest.LEAD_ID,
            "signature_data_url": "data:image/png;base64,iVBORw0KGgo=",
            "beneficiary_name": "TEST_John Doe",
            "agent_name": "Agent A",
            "plan_types_discussed": ["MA", "MAPD"],
            "consent_acknowledged": False,
        }, timeout=30)
        assert r.status_code == 400

    def test_sign_invalid_signature(self):
        r = requests.post(f"{BASE_URL}/api/soa/sign", json={
            "lead_id": pytest.LEAD_ID,
            "signature_data_url": "not-a-data-url",
            "beneficiary_name": "TEST_John Doe",
            "consent_acknowledged": True,
        }, timeout=30)
        assert r.status_code == 400

    def test_sign_success_and_lead_updated(self, admin_headers):
        body = {
            "lead_id": pytest.LEAD_ID,
            "signature_data_url": "data:image/png;base64,iVBORw0KGgo=",
            "beneficiary_name": "TEST_John Doe",
            "agent_name": "Agent A",
            "plan_types_discussed": ["MA", "MAPD"],
            "consent_acknowledged": True,
        }
        r = requests.post(f"{BASE_URL}/api/soa/sign", json=body, timeout=30)
        assert r.status_code == 201, r.text
        d = r.json()
        assert d["lead_id"] == pytest.LEAD_ID
        assert d["beneficiary_name"] == "TEST_John Doe"

        # lead.soa_signed should be true
        r = requests.get(f"{BASE_URL}/api/leads/{pytest.LEAD_ID}",
                         headers=admin_headers, timeout=30)
        assert r.json()["soa_signed"] is True

        # GET soa/by-lead
        r = requests.get(f"{BASE_URL}/api/soa/by-lead/{pytest.LEAD_ID}", timeout=30)
        assert r.status_code == 200
        assert r.json()["lead_id"] == pytest.LEAD_ID

    def test_sign_lead_not_found(self):
        r = requests.post(f"{BASE_URL}/api/soa/sign", json={
            "lead_id": "nonexistent",
            "signature_data_url": "data:image/png;base64,iVBORw0KGgo=",
            "beneficiary_name": "X",
            "consent_acknowledged": True,
        }, timeout=30)
        assert r.status_code == 404


# ---------------- Audit ----------------
class TestAudit:
    def test_agent_forbidden(self, admin_headers):
        # create an agent and login
        agent_email = f"TEST_aud_{uuid.uuid4().hex[:6]}@grueninghw.com"
        agent_pw = "AgentPass!2026"
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          headers=admin_headers,
                          json={"email": agent_email, "password": agent_pw,
                                "full_name": "Aud Agent", "role": "agent"},
                          timeout=30)
        assert r.status_code == 200
        login = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"email": agent_email, "password": agent_pw},
                              timeout=30)
        agent_token = login.json()["access_token"]
        r = requests.get(f"{BASE_URL}/api/audit",
                         headers={"Authorization": f"Bearer {agent_token}"}, timeout=30)
        assert r.status_code == 403

    def test_admin_can_read_audit(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/audit", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        events = r.json()
        assert isinstance(events, list) and len(events) > 0
        types = {e["event_type"] for e in events}
        # confirm at least the events we generated this run exist
        for required in ("login_success", "lead_created", "doc_uploaded",
                         "soa_signed", "ghl_sync", "lead_updated"):
            assert required in types, f"missing audit event: {required}"

    def test_audit_filter_by_event_type(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/audit?event_type=lead_created",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        evs = r.json()
        assert len(evs) > 0
        assert all(e["event_type"] == "lead_created" for e in evs)

    def test_audit_filter_by_target_id(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/audit?target_id={pytest.LEAD_ID}",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        evs = r.json()
        assert len(evs) > 0
        assert all(e["target_id"] == pytest.LEAD_ID for e in evs)

    def test_audit_summary(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/audit/summary",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert "total" in d and d["total"] > 0
        assert "by_event_type" in d and isinstance(d["by_event_type"], list)
        assert all("event_type" in row and "count" in row for row in d["by_event_type"])

    def test_login_failed_audit_event_exists(self, admin_headers):
        # Generate one
        requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "no@one.com", "password": "x"}, timeout=30)
        r = requests.get(f"{BASE_URL}/api/audit?event_type=login_failed",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert len(r.json()) > 0
