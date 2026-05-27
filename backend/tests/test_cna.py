"""CNA + AI Client Intelligence + Daily Brief tests.

Uses the conftest in-process TestClient + mongomock. ANTHROPIC_API_KEY
is unset in the test env so the AI analyser short-circuits to the
safe default — we assert on the cache fields + structure, not on the
content of the AI response.
"""
import pytest

from datetime import date, datetime, timezone


# ── Helpers ─────────────────────────────────────────────────────────────────
def _make_agent_with_token(client, admin_headers, email, name,
                            password="Q9pl#aux!7zT"):
    """Invite + register + approve an agent. Returns (id, headers)."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": email, "full_name": name,
        "agency_name": "GHW", "agent_name": name,
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": email, "password": password,
        "full_name": name, "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    assert reg.status_code == 201, reg.text
    uid = reg.json()["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": email, "password": password,
    })
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return uid, headers


def _create_lead(client, headers, **overrides):
    payload = {
        "first_name": "Test",
        "last_name": "Client",
        "phone": "555-100-0001",
        "email": "test.client@example.com",
        "state": "IL",
        "zip_code": "60601",
        "date_of_birth": "1959-06-15",
        "current_carrier": "BCBS",
        "current_plan": "PPO",
        "prescriptions": ["Metformin", "Lisinopril"],
        "doctors": ["Dr. Robert Chen"],
    }
    payload.update(overrides)
    r = client.post("/api/leads", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    return r.json()


# ── GET (empty + populated) ─────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_get_cna_returns_template_when_missing(client, admin_headers):
    lead = _create_lead(client, admin_headers)
    r = client.get(f"/api/cna/{lead['id']}", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["exists"] is False
    cna = body["cna"]
    # Pre-fills from the lead.
    assert cna["zip_code"] == "60601"
    assert cna["date_of_birth"] == "1959-06-15"
    assert cna["current_carrier"] == "BCBS"
    # Prescriptions / doctors mapped into the structured CNA shape.
    rx_names = [p["name"] for p in cna["prescriptions"]]
    assert "Metformin" in rx_names
    assert "Lisinopril" in rx_names
    docs = [d["name"] for d in cna["preferred_doctors"]]
    assert "Dr. Robert Chen" in docs


@pytest.mark.asyncio
async def test_get_cna_404_when_lead_missing(client, admin_headers):
    r = client.get("/api/cna/not-a-real-lead", headers=admin_headers)
    assert r.status_code == 404


# ── POST (save) ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_save_cna_persists_and_audits(client, db, admin_headers):
    lead = _create_lead(client, admin_headers)
    payload = {
        "employment_status": "retired",
        "drawing_social_security": True,
        "household_income_range": "85k_107k",
        "current_coverage_type": "employer",
        "current_monthly_premium": 340.0,
        "current_deductible": 1500.0,
        "current_max_oop": 5000.0,
        "hit_deductible_this_year": True,
        "health_history_notes": "Type 2 diabetes managed with Metformin.",
        "prescription_count": 2,
        "prescriptions": [
            {"name": "Metformin", "condition": "Diabetes"},
            {"name": "Lisinopril", "condition": "Hypertension"},
        ],
        "critical_illness_history": "family",
        "critical_illness_notes": "Father had heart disease.",
        "preferred_doctors": [
            {"name": "Dr. Robert Chen", "specialty": "Internal Medicine"},
        ],
        "knows_ma_vs_supp_difference": "somewhat",
        "medicare_direction_preference": "supplement",
        "appointment_goal": "Find a plan that covers my current doctors.",
    }
    r = client.post(f"/api/cna/{lead['id']}", headers=admin_headers,
                     json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    saved = body["cna"]
    assert saved["employment_status"] == "retired"
    assert saved["prescription_count"] == 2
    assert saved["prescriptions"][0]["name"] == "Metformin"
    # Without run_ai=true the AI fields stay absent.
    assert body.get("ai_recommendation") is None

    # Verify in DB
    row = await db.cna_assessments.find_one({"lead_id": lead["id"]})
    assert row is not None
    assert row["agent_id"] is not None
    assert row["completed_at"] is not None

    # Audit row written
    audit = await db.audit_logs.find_one({"event_type": "cna_saved"})
    assert audit is not None
    assert audit["target_id"] == lead["id"]


@pytest.mark.asyncio
async def test_save_cna_upserts_on_second_call(client, db, admin_headers):
    lead = _create_lead(client, admin_headers)
    client.post(f"/api/cna/{lead['id']}", headers=admin_headers, json={
        "employment_status": "working",
    })
    r2 = client.post(f"/api/cna/{lead['id']}", headers=admin_headers, json={
        "employment_status": "retired",
        "household_income_range": "over_160k",
    })
    assert r2.status_code == 200
    assert r2.json()["cna"]["employment_status"] == "retired"
    assert r2.json()["cna"]["household_income_range"] == "over_160k"
    count = await db.cna_assessments.count_documents({"lead_id": lead["id"]})
    assert count == 1


@pytest.mark.asyncio
async def test_second_save_never_sets_immutable_id(client, db, admin_headers):
    """Regression for the prod "couldn't save cna" bug.

    Real MongoDB rejects any $set that touches the immutable _id field
    (mongomock doesn't, which is why the bug only surfaced on Render).
    Approach: seed the cna_assessments row directly with a known
    sentinel _id, then issue a save via the endpoint. If the endpoint
    were carrying _id into its $set payload, mongomock would silently
    overwrite our sentinel. After the save we assert the _id is still
    the sentinel value — i.e. the endpoint never touched it.
    """
    lead = _create_lead(client, admin_headers)

    # Seed an existing CNA row with a sentinel _id.
    sentinel = "test-sentinel-id-do-not-overwrite"
    await db.cna_assessments.insert_one({
        "_id": sentinel,
        "id": sentinel,
        "lead_id": lead["id"],
        "agent_id": "seeded-agent",
        "agency_id": "ghw_001",
        "employment_status": "working",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "completed_at": "2026-01-01T00:00:00+00:00",
    })

    # Now POST an update — this is the path that pre-fix would have
    # $set'd _id back in. 200 + sentinel preserved means we stripped it.
    r = client.post(
        f"/api/cna/{lead['id']}",
        headers=admin_headers,
        json={"employment_status": "retired"},
    )
    assert r.status_code == 200, r.text

    stored = await db.cna_assessments.find_one({"lead_id": lead["id"]})
    assert stored is not None
    assert stored["_id"] == sentinel, (
        f"endpoint mutated immutable _id (was {sentinel!r}, "
        f"now {stored['_id']!r}) — $set payload must strip _id"
    )
    # Sanity: the rest of the doc DID update.
    assert stored["employment_status"] == "retired"


# ── AI analysis (safe-default path) ─────────────────────────────────────────
@pytest.mark.asyncio
async def test_save_cna_with_run_ai_returns_safe_default(client, admin_headers,
                                                          monkeypatch):
    """No ANTHROPIC_API_KEY in test env — the analyser returns the
    safe-default dict and stamps ai_generated_at. UI relies on this
    shape regardless of whether Claude actually ran."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    lead = _create_lead(client, admin_headers)
    r = client.post(
        f"/api/cna/{lead['id']}?run_ai=true",
        headers=admin_headers,
        json={
            "employment_status": "retired",
            "medicare_direction_preference": "supplement",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_recommendation"] is not None
    ai = body["ai_recommendation"]
    # Safe-default shape.
    for key in (
        "recommended_plan_type", "recommended_umbrella", "confidence",
        "primary_reason", "urgency_score", "urgency_reason",
        "key_exposures", "talking_points",
        "cross_sell_opportunities", "objection_handles",
        "formal_recommendation_script", "next_best_action",
    ):
        assert key in ai
    assert body["ai_generated_at"] is not None


@pytest.mark.asyncio
async def test_trigger_ai_analysis_endpoint(client, admin_headers, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    lead = _create_lead(client, admin_headers)
    # Save a CNA first.
    client.post(f"/api/cna/{lead['id']}", headers=admin_headers, json={
        "employment_status": "retired",
    })
    r = client.post(
        f"/api/cna/{lead['id']}/ai-analysis", headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_recommendation"] is not None
    assert body["ai_generated_at"] is not None


@pytest.mark.asyncio
async def test_trigger_ai_404_when_no_cna(client, admin_headers):
    lead = _create_lead(client, admin_headers)
    r = client.post(
        f"/api/cna/{lead['id']}/ai-analysis", headers=admin_headers,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_ai_analysis_returns_none_when_missing(client, admin_headers):
    lead = _create_lead(client, admin_headers)
    r = client.get(
        f"/api/cna/{lead['id']}/ai-analysis", headers=admin_headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ai_recommendation"] is None
    assert body["exists"] is False


# ── Agent isolation ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_agent_cannot_read_anothers_cna(client, db, admin_headers):
    # Create two agents.
    _, a_headers = _make_agent_with_token(
        client, admin_headers, "agent.a@example.com", "Agent Alpha",
    )
    _, b_headers = _make_agent_with_token(
        client, admin_headers, "agent.b@example.com", "Agent Bravo",
    )
    # Agent A creates a lead + CNA.
    lead = _create_lead(client, a_headers,
                         first_name="Iso", last_name="Lated",
                         email="iso@example.com")
    save = client.post(f"/api/cna/{lead['id']}", headers=a_headers, json={
        "employment_status": "retired",
    })
    assert save.status_code == 200, save.text

    # Agent B can't see it.
    r = client.get(f"/api/cna/{lead['id']}", headers=b_headers)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_read_and_write_any_agents_cna(client, db, admin_headers):
    """Regression test for production 403 bug.

    An admin must be able to GET + POST a CNA for a lead owned by
    another agent — directly (no impersonation header) AND while
    impersonating a third agent. The pre-fix code only checked the
    effective agent's role, so an admin who didn't own the lead got
    403 even though they have agency-wide access.
    """
    # Agent A creates a lead with a CNA they own.
    _, a_headers = _make_agent_with_token(
        client, admin_headers, "agent.alpha2@example.com", "Agent Alpha",
    )
    lead = _create_lead(client, a_headers,
                         first_name="Cross", last_name="Agent",
                         email="cross@example.com")

    # Admin GETs the (empty) CNA template for that lead — should
    # succeed even though admin doesn't own the lead.
    r = client.get(f"/api/cna/{lead['id']}", headers=admin_headers)
    assert r.status_code == 200, r.text

    # Admin POSTs a CNA save against the lead they don't own.
    r2 = client.post(
        f"/api/cna/{lead['id']}",
        headers=admin_headers,
        json={"employment_status": "working"},
    )
    assert r2.status_code == 200, r2.text


@pytest.mark.asyncio
async def test_admin_impersonating_third_agent_still_works(
    client, db, admin_headers,
):
    """Admin uses X-Agent-ID to impersonate Agent A while saving a CNA
    for a lead Agent A actually owns. The impersonated agent owns the
    lead so the IDOR check passes via the ownership branch, regardless
    of role bypass."""
    # Agent A owns the lead.
    a_id, a_headers = _make_agent_with_token(
        client, admin_headers, "agent.imp@example.com", "Agent Imp",
    )
    lead = _create_lead(client, a_headers,
                         first_name="Imp", last_name="Lead",
                         email="imp@example.com")

    # Admin impersonates Agent A — POST succeeds (lead is in scope).
    impersonate_headers = {**admin_headers, "X-Agent-ID": a_id}
    r = client.post(
        f"/api/cna/{lead['id']}",
        headers=impersonate_headers,
        json={"employment_status": "retired"},
    )
    assert r.status_code == 200, r.text


def test_is_privileged_handles_case_and_missing_role():
    """The lowercased role check must survive legacy capitalised roles
    and an unset role field (e.g. a row that pre-dates the role column)."""
    from cna_router import _is_privileged
    assert _is_privileged({"role": "admin"}) is True
    assert _is_privileged({"role": "Admin"}) is True
    assert _is_privileged({"role": "OWNER"}) is True
    assert _is_privileged({"role": "agent"}) is False
    assert _is_privileged({}) is False
    assert _is_privileged(None) is False


# ── Urgency scoring (pure-function unit tests) ──────────────────────────────
def test_compute_lead_urgency_birthday_window_open():
    from automations import compute_lead_urgency
    today = date(2026, 6, 30)
    # Birthday June 15 — 15 days into the IL window.
    lead = {
        "date_of_birth": "1959-06-15",
        "state": "IL",
        "status": "new",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    v = compute_lead_urgency(lead, today=today)
    assert v["score"] >= 40
    assert any("Birthday window OPEN" in r for r in v["reasons"])


def test_compute_lead_urgency_stale_lead():
    from automations import compute_lead_urgency
    today = date(2026, 6, 30)
    # 75 days since update — past the 60-day "going cold" threshold.
    stale_dt = datetime(2026, 4, 15, tzinfo=timezone.utc).isoformat()
    lead = {
        "date_of_birth": "1959-01-01",
        "state": "TX",
        "status": "contacted",
        "updated_at": stale_dt,
    }
    v = compute_lead_urgency(lead, today=today)
    assert v["score"] >= 25
    assert any("going cold" in r for r in v["reasons"])


def test_compute_lead_urgency_turning_65():
    from automations import compute_lead_urgency
    today = date(2026, 6, 30)
    # Born Sep 20, 1961 → turns 65 on 2026-09-20 → ~82 days out.
    lead = {
        "date_of_birth": "1961-09-20",
        "state": "TX",
        "status": "new",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    v = compute_lead_urgency(lead, today=today)
    assert v["score"] >= 30
    assert any("Turning 65" in r for r in v["reasons"])


def test_compute_lead_urgency_aep_bonus():
    from automations import compute_lead_urgency
    today = date(2026, 10, 20)  # inside AEP
    lead = {
        "date_of_birth": "1955-01-01",
        "state": "TX",
        "status": "contacted",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    v = compute_lead_urgency(lead, today=today)
    assert any("AEP" in r for r in v["reasons"])


def test_compute_lead_urgency_levels():
    from automations import compute_lead_urgency
    today = date(2026, 6, 30)
    # Empty record → no contact + no DOB → score=30, "moderate".
    minimal = {"created_at": datetime.now(timezone.utc).isoformat()}
    v = compute_lead_urgency(minimal, today=today)
    assert v["urgency_level"] in ("low", "moderate")


# ── Daily Brief ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_brief_today_returns_structure_when_empty(client, admin_headers):
    r = client.get("/api/brief/today", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("agent_id", "date", "generated_at",
                 "top_calls", "total_urgent", "total_priority"):
        assert key in body
    assert isinstance(body["top_calls"], list)


@pytest.mark.asyncio
async def test_brief_today_includes_high_urgency_leads(client, db,
                                                        admin_headers):
    # Create a lead with a wide-open IL birthday window + recent update.
    today = datetime.now(timezone.utc).date()
    dob = today.replace(year=today.year - 67).isoformat()
    _create_lead(client, admin_headers,
                  first_name="Margaret", last_name="Johnson",
                  email="m.j@example.com",
                  state="IL", zip_code="60601",
                  date_of_birth=dob, phone="555-200-0001")
    r = client.get("/api/brief/today", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # On-demand build path should have run a brief now.
    assert isinstance(body["top_calls"], list)
    # Margaret should appear with a non-zero score because her
    # birthday window is open today.
    names = [c["name"] for c in body["top_calls"]]
    assert "Margaret Johnson" in names
    margaret = next(c for c in body["top_calls"] if c["name"] == "Margaret Johnson")
    assert margaret["score"] >= 40


@pytest.mark.asyncio
async def test_build_brief_stamps_ai_score_on_lead(client, db, admin_headers):
    from automations import build_brief_for_agent
    # Find the admin user doc.
    admin = await db.users.find_one({"role": "admin"})
    assert admin
    today = datetime.now(timezone.utc).date()
    dob = today.replace(year=today.year - 67).isoformat()
    lead = _create_lead(client, admin_headers,
                         first_name="Score", last_name="Test",
                         email="score@example.com",
                         state="IL", zip_code="60601",
                         date_of_birth=dob, phone="555-300-0001")
    await build_brief_for_agent(db, admin, persist=True)
    refreshed = await db.leads.find_one({"id": lead["id"]})
    assert refreshed.get("ai_score") is not None
    assert refreshed.get("ai_score") >= 40
    assert refreshed.get("ai_score_reason")
    assert refreshed.get("ai_score_updated")
