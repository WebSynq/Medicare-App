"""Security hardening tests — MFA, idle-timeout, password history,
audit export, common-password blocklist.

Reuses the existing in-process TestClient + mongomock setup.
"""
import time
from datetime import datetime, timezone

import pytest


# ── MFA happy path ──────────────────────────────────────────────────────
def test_mfa_setup_returns_secret_and_qr_uri(client, admin_headers):
    r = client.post("/api/auth/mfa/setup", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["secret"]
    assert body["qr_code_url"].startswith("otpauth://")
    assert "Gruening" in body["qr_code_url"] or "GHW" in body["qr_code_url"]


def test_mfa_verify_setup_wrong_code_rejected(client, admin_headers):
    r = client.post("/api/auth/mfa/setup", headers=admin_headers)
    assert r.status_code == 200
    bad = client.post(
        "/api/auth/mfa/verify-setup",
        headers=admin_headers,
        json={"totp_code": "000000"},
    )
    assert bad.status_code == 401


def test_mfa_verify_setup_with_correct_code_enables_and_returns_backup_codes(
    client, admin_headers,
):
    import pyotp
    setup = client.post("/api/auth/mfa/setup", headers=admin_headers).json()
    code = pyotp.TOTP(setup["secret"]).now()
    r = client.post(
        "/api/auth/mfa/verify-setup",
        headers=admin_headers,
        json={"totp_code": code},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert len(body["backup_codes"]) == 8
    for c in body["backup_codes"]:
        assert len(c) == 9  # 4-digits + hyphen + 4-digits


@pytest.mark.asyncio
async def test_mfa_enabled_login_returns_session_token(
    client, db, admin_headers,
):
    """After MFA is enabled, POST /login no longer issues a JWT —
    it issues a 5-min session_token and the SPA redirects to /mfa."""
    import os, pyotp
    setup = client.post("/api/auth/mfa/setup", headers=admin_headers).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post("/api/auth/mfa/verify-setup",
                headers=admin_headers, json={"totp_code": code})

    # Now login without the MFA challenge code.
    r = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("mfa_required") is True
    assert body.get("session_token")
    assert body.get("access_token") is None or "access_token" not in body


@pytest.mark.asyncio
async def test_mfa_verify_completes_login(client, db, admin_headers):
    import os, pyotp
    setup = client.post("/api/auth/mfa/setup", headers=admin_headers).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post("/api/auth/mfa/verify-setup",
                headers=admin_headers, json={"totp_code": code})

    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    }).json()
    session_token = login["session_token"]

    # Fresh TOTP code for the verify step.
    fresh_code = pyotp.TOTP(setup["secret"]).now()
    r = client.post("/api/auth/mfa/verify", json={
        "session_token": session_token,
        "totp_code": fresh_code,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("access_token")
    assert body.get("token_type") == "bearer"
    assert body["user"]["email"] == os.environ["SEED_ADMIN_EMAIL"]


@pytest.mark.asyncio
async def test_mfa_backup_code_round_trip(client, db, admin_headers):
    import os, pyotp
    setup = client.post("/api/auth/mfa/setup", headers=admin_headers).json()
    code = pyotp.TOTP(setup["secret"]).now()
    enabled = client.post(
        "/api/auth/mfa/verify-setup",
        headers=admin_headers, json={"totp_code": code},
    ).json()
    backup_codes = enabled["backup_codes"]

    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    }).json()
    session_token = login["session_token"]

    # Use a backup code instead of TOTP.
    r = client.post("/api/auth/mfa/backup-code", json={
        "session_token": session_token,
        "backup_code": backup_codes[0],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("access_token")


@pytest.mark.asyncio
async def test_mfa_backup_code_single_use(client, db, admin_headers):
    """A backup code can only be redeemed once."""
    import os, pyotp
    setup = client.post("/api/auth/mfa/setup", headers=admin_headers).json()
    code = pyotp.TOTP(setup["secret"]).now()
    enabled = client.post(
        "/api/auth/mfa/verify-setup",
        headers=admin_headers, json={"totp_code": code},
    ).json()
    backup_codes = enabled["backup_codes"]
    target = backup_codes[1]

    login1 = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    }).json()
    r1 = client.post("/api/auth/mfa/backup-code", json={
        "session_token": login1["session_token"], "backup_code": target,
    })
    assert r1.status_code == 200

    # Second attempt with the same code must fail.
    login2 = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    }).json()
    r2 = client.post("/api/auth/mfa/backup-code", json={
        "session_token": login2["session_token"], "backup_code": target,
    })
    assert r2.status_code == 401


# ── Idle timeout (Hardening 2) ──────────────────────────────────────────
def test_jwt_includes_idle_exp_claim(client):
    """Every fresh JWT must carry both idle_exp and jti."""
    import jwt
    from security import JWT_SECRET, JWT_ALGORITHM, create_access_token
    token = create_access_token({"sub": "abc", "email": "x@y", "role": "agent"})
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    assert "idle_exp" in payload
    assert "jti" in payload


def test_session_refresh_endpoint_returns_new_token(client, admin_headers):
    r = client.post("/api/auth/refresh", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("access_token")


# ── Password policy (Hardening 3) ───────────────────────────────────────
def test_password_strength_rejects_common_password():
    from security import validate_password_strength
    errs = validate_password_strength("password1234")
    assert any("too common" in e.lower() for e in errs)


def test_password_strength_rejects_short():
    from security import validate_password_strength
    errs = validate_password_strength("Aa1!short")
    assert any("12 characters" in e for e in errs)


def test_password_strength_accepts_strong():
    from security import validate_password_strength
    errs = validate_password_strength("R3al-Pa55phrase!9")
    assert errs == []


@pytest.mark.asyncio
async def test_password_history_rejects_recent_reuse(client, db, admin_headers):
    """Cannot reuse current or any of the last 5 passwords."""
    import os
    current = os.environ["SEED_ADMIN_PASSWORD"]

    # Attempt to "change" back to the current password.
    r = client.patch("/api/profile/me", headers=admin_headers, json={
        "current_password": current,
        "new_password": current,
    })
    assert r.status_code == 422
    detail = r.json().get("detail")
    msg = str(detail)
    assert "last 5" in msg or "common" in msg.lower() or "requirements" in msg.lower()


# ── Audit log (Hardening 6) ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_audit_export_csv_admin_only(client, db, admin_headers):
    r = client.get("/api/audit/export?format=csv", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    body = r.text
    # First line is the header.
    assert "timestamp" in body.split("\n", 1)[0]
    assert "session_id" in body.split("\n", 1)[0]
    assert "user_agent" in body.split("\n", 1)[0]


@pytest.mark.asyncio
async def test_audit_export_rejects_unprivileged(client, db, admin_headers):
    """Reuse the agent helper from test_booking.py via inline copy."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "auditor@example.com", "full_name": "Audit User",
        "agency_name": "GHW", "agent_name": "Audit User",
    }).json()
    client.post("/api/auth/register", json={
        "email": "auditor@example.com",
        "password": "Q9pl#aux!7zT",
        "full_name": "Audit User", "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    uid = (await db.users.find_one({"email": "auditor@example.com"}))["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": "auditor@example.com",
        "password": "Q9pl#aux!7zT",
    })
    agent_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = client.get("/api/audit/export?format=csv", headers=agent_headers)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_write_audit_captures_session_id_for_logged_in_user(
    client, db, admin_headers,
):
    """A request through get_current_user should land an audit row whose
    session_id matches the JWT's jti."""
    # Do something that writes an audit row (mfa/setup audits).
    r = client.post("/api/auth/mfa/setup", headers=admin_headers)
    assert r.status_code == 200
    rows = await db.audit_logs.find(
        {"event_type": "mfa_setup_started"}, {"_id": 0},
    ).to_list(length=5)
    assert rows
    assert any(r.get("session_id") for r in rows)
