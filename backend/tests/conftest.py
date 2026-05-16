"""Shared pytest fixtures for backend tests."""
import os
import requests
import pytest
from dotenv import load_dotenv
from pathlib import Path

# Load frontend .env to get the public REACT_APP_BACKEND_URL
load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@grueninghw.com"
ADMIN_PASSWORD = "ChangeMe!2026Admin"


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_token():
    """Login as seeded admin and return JWT (skip downstream tests if it fails)."""
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text}")
    data = r.json()
    if data.get("mfa_required"):
        pytest.skip("Admin already has MFA enabled — cannot get full token without code")
    return data["access_token"]


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}",
            "Content-Type": "application/json"}
