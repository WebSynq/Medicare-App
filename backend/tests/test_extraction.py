"""Per-document Bedrock extraction + cross-reference conflict tests.

Bedrock is monkey-patched to a deterministic stub so the tests run
offline. The stub returns the canonical fields-and-confidences shape
that the real model produces, so we exercise the routing, persistence,
and conflict-detection logic without paying for real Bedrock calls."""
import json

import pytest


# ── extraction_schemas — pure functions ─────────────────────────────────
def test_label_to_doc_type_known_and_unknown():
    from extraction_schemas import label_to_doc_type
    assert label_to_doc_type("SOA") == "soa"
    assert label_to_doc_type("Election Notice") == "election_notice"
    assert label_to_doc_type("EFT Form") == "eft_form"
    assert label_to_doc_type("PHI Auth") == "phi_auth"
    assert label_to_doc_type("ID Copy") == "id_copy"
    assert label_to_doc_type("Prescription List") == "prescriptions"
    assert label_to_doc_type("Agent Attestation") == "agent_attestation"
    assert label_to_doc_type("Other") == "other"
    assert label_to_doc_type(None) == "other"
    assert label_to_doc_type("Nonsense") == "other"


def test_build_prompt_includes_every_field_for_each_doc_type():
    """The prompt MUST mention every field name from SCHEMA_FIELDS so
    the model knows what to extract."""
    from extraction_schemas import SCHEMA_FIELDS, build_prompt
    for doc_type, fields in SCHEMA_FIELDS.items():
        prompt = build_prompt(doc_type)
        assert doc_type in prompt, doc_type
        for f in fields:
            assert f in prompt, (doc_type, f)


# ── Cross-reference conflict detector ──────────────────────────────────
def test_detect_conflicts_finds_disagreement_across_docs():
    """ID copy says 'Jane M Doe', main app says 'Jane Doe' — these
    normalise to different strings so the detector flags them."""
    from extraction_schemas import detect_conflicts
    conflicts = detect_conflicts({
        "main_application": {"applicant_full_name": "Jane Doe"},
        "id_copy": {"full_name": "Jane M Doe"},
    })
    names = [c["canonical"] for c in conflicts]
    assert "full_name" in names
    full_name_conflict = next(c for c in conflicts if c["canonical"] == "full_name")
    sources = full_name_conflict["sources"]
    assert {s["doc_type"] for s in sources} == {"main_application", "id_copy"}


def test_detect_conflicts_quiet_when_docs_agree():
    """Same canonical value across docs (modulo whitespace / punctuation)
    must NOT raise a conflict — false positives ruin the review screen."""
    from extraction_schemas import detect_conflicts
    conflicts = detect_conflicts({
        "main_application": {"applicant_full_name": "Jane Doe",
                              "applicant_dob": "1955-04-15"},
        "soa": {"client_name": "  Jane Doe ", "client_dob": "1955-04-15"},
        "id_copy": {"full_name": "Jane Doe"},
    })
    canonical_names = {c["canonical"] for c in conflicts}
    assert "full_name" not in canonical_names
    assert "dob" not in canonical_names


def test_detect_conflicts_ignores_blank_fields():
    """A blank field in one doc must NOT be treated as a conflicting
    value against a populated field in another doc."""
    from extraction_schemas import detect_conflicts
    conflicts = detect_conflicts({
        "main_application": {"applicant_full_name": "Jane Doe"},
        "id_copy": {"full_name": ""},
        "soa": {"client_name": None},
    })
    assert all(c["canonical"] != "full_name" for c in conflicts)


def test_detect_conflicts_compares_booleans():
    """agent_signature_present=true on main vs false on attestation
    should be flagged — that's a real compliance discrepancy."""
    from extraction_schemas import detect_conflicts
    conflicts = detect_conflicts({
        "main_application": {"agent_signature_present": True},
        "agent_attestation": {"agent_signature_present": False},
    })
    names = [c["canonical"] for c in conflicts]
    assert "agent_signature_present" in names


# ── GHL payload builder ────────────────────────────────────────────────
def test_build_ghl_payload_prefers_main_then_falls_back():
    """When the same canonical field appears in multiple docs, the
    main application's value wins; missing main values fall through to
    SOA / ID / etc."""
    from extraction_schemas import build_ghl_payload
    payload = build_ghl_payload({
        "main_application": {
            "applicant_full_name": "Jane Doe",
            "applicant_dob": "1955-04-15",
            "plan_name": "Aetna PPO",
        },
        "id_copy": {
            "full_name": "Jane M Doe",  # ignored — main wins
            "medicare_beneficiary_id": "1EG4-TE5-MK72",
        },
    })
    by_key = {p["key"]: p["field_value"] for p in payload}
    assert by_key["date_of_birth"] == "1955-04-15"
    assert by_key["current_plan"] == "Aetna PPO"
    # MBI fell back to id_copy since main_application didn't supply one.
    assert by_key["medicare_id"] == "1EG4-TE5-MK72"


def test_build_ghl_payload_empty_when_nothing_extracted():
    from extraction_schemas import build_ghl_payload
    assert build_ghl_payload({}) == []
    assert build_ghl_payload({"main_application": {}}) == []


# ── /extract second-pass + /upload-supporting parallel extraction ──────
@pytest.fixture(autouse=True)
def _stub_bedrock_extract(monkeypatch):
    """Per-doc-type stub for ``_bedrock_extract_doc``.

    Returns deterministic fields keyed by doc type so we can assert on
    routing without invoking real Bedrock."""
    import application_router

    def _stub(_pdf_bytes, doc_type):
        canned = {
            "main_application": (
                {"applicant_full_name": "Jane Doe",
                 "applicant_dob": "1955-04-15",
                 "applicant_medicare_id": "1EG4-TE5-MK72",
                 "agent_signature_present": True},
                {"applicant_full_name": 0.95,
                 "applicant_dob": 0.92,
                 "applicant_medicare_id": 0.7,
                 "agent_signature_present": 0.5},
            ),
            "soa": (
                {"client_name": "Jane Doe",
                 "client_dob": "1955-04-15",
                 "products_discussed": ["MA", "PDP"],
                 "appointment_type": "phone"},
                {"client_name": 0.9, "client_dob": 0.9,
                 "products_discussed": 0.88, "appointment_type": 0.9},
            ),
            "id_copy": (
                {"full_name": "Jane M Doe",  # intentional mismatch
                 "medicare_beneficiary_id": "1EG4-TE5-MK72"},
                {"full_name": 0.95, "medicare_beneficiary_id": 0.98},
            ),
            "eft_form": (
                {"payment_method": "EFT", "account_type": "checking",
                 "routing_number": "021000021",
                 "account_number": "1234567890"},
                {"payment_method": 0.95, "account_type": 0.95,
                 "routing_number": 0.9, "account_number": 0.9},
            ),
            "phi_auth": (
                {"client_name": "Jane Doe",
                 "authorized_parties": ["Spouse", "Daughter"],
                 "client_signature_present": True},
                {"client_name": 0.9, "authorized_parties": 0.85,
                 "client_signature_present": 0.95},
            ),
            "election_notice": (
                {"plan_name": "Aetna PPO", "carrier": "Aetna",
                 "premium": "0", "deductible": "0"},
                {"plan_name": 0.95, "carrier": 0.95},
            ),
            "prescriptions": (
                {"medications": [
                    {"drug_name": "Metformin", "dosage": "500mg",
                     "frequency": "BID", "prescribing_physician": "Dr. Smith"},
                ]},
                {"medications": 0.9},
            ),
            "agent_attestation": (
                {"agent_name": "Tim Arnold", "agent_npn": "12345",
                 "agent_signature_present": True,
                 "carrier": "Aetna", "plan_name": "Aetna PPO"},
                {"agent_name": 0.95, "agent_npn": 0.95,
                 "agent_signature_present": 0.95},
            ),
            "other": (
                {"names_detected": ["Jane Doe"],
                 "dates_detected": ["2026-05-20"]},
                {"names_detected": 0.7, "dates_detected": 0.7},
            ),
        }
        return canned.get(doc_type, ({}, {}))

    monkeypatch.setattr(application_router, "_bedrock_extract_doc", _stub)


PDF = b"%PDF-1.4\n%test payload\n"


def _post_supporting(client, headers, files_and_labels):
    """Multipart helper: files_and_labels is [(filename, label, bytes)]."""
    files = [
        ("files", (fn, b, "application/pdf"))
        for fn, _label, b in files_and_labels
    ]
    labels = json.dumps([lbl for _, lbl, _ in files_and_labels])
    return client.post(
        "/api/applications/upload-supporting",
        headers=headers,
        data={"labels": labels, "contact_id": "C-1"},
        files=files,
    )


def test_upload_supporting_extracts_per_doc_type_in_parallel(client, admin_headers):
    """Three different doc types in one batch — every row must come back
    with extracted + confidences shaped to that doc type's schema."""
    r = _post_supporting(client, admin_headers, [
        ("soa.pdf", "SOA", PDF),
        ("id.pdf", "ID Copy", PDF),
        ("eft.pdf", "EFT Form", PDF),
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    by_label = {f["file_label"]: f for f in body["files"]}
    soa = by_label["SOA"]
    assert soa["doc_type"] == "soa"
    assert soa["extracted"]["client_name"] == "Jane Doe"
    assert soa["extracted"]["products_discussed"] == ["MA", "PDP"]
    assert soa["confidences"]["client_name"] >= 0.85
    id_row = by_label["ID Copy"]
    assert id_row["doc_type"] == "id_copy"
    assert id_row["extracted"]["medicare_beneficiary_id"]
    eft_row = by_label["EFT Form"]
    assert eft_row["doc_type"] == "eft_form"
    assert eft_row["extracted"]["routing_number"] == "021000021"


def test_upload_supporting_prescription_list_returns_medications_array(
    client, admin_headers,
):
    r = _post_supporting(client, admin_headers, [
        ("rx.pdf", "Prescription List", PDF),
    ])
    assert r.status_code == 200, r.text
    row = r.json()["files"][0]
    assert row["doc_type"] == "prescriptions"
    meds = row["extracted"]["medications"]
    assert isinstance(meds, list) and len(meds) >= 1
    assert meds[0]["drug_name"] == "Metformin"


def test_upload_supporting_agent_attestation_extracts(client, admin_headers):
    r = _post_supporting(client, admin_headers, [
        ("attest.pdf", "Agent Attestation", PDF),
    ])
    assert r.status_code == 200, r.text
    row = r.json()["files"][0]
    assert row["doc_type"] == "agent_attestation"
    assert row["extracted"]["agent_npn"] == "12345"
    assert row["extracted"]["agent_signature_present"] is True


def test_upload_supporting_other_runs_general_extraction(client, admin_headers):
    r = _post_supporting(client, admin_headers, [
        ("anything.pdf", "Other", PDF),
    ])
    assert r.status_code == 200, r.text
    row = r.json()["files"][0]
    assert row["doc_type"] == "other"
    assert "names_detected" in row["extracted"]


def test_upload_supporting_skips_extraction_for_images(client, admin_headers):
    """Images can't be Bedrock-document-extracted, but the upload must
    still succeed with an empty extracted dict so the SPA can show the
    image row + let the agent transcribe manually."""
    jpg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        data={"labels": json.dumps(["ID Copy"]), "contact_id": "C-1"},
        files=[("files", ("id.jpg", jpg, "image/jpeg"))],
    )
    assert r.status_code == 200, r.text
    row = r.json()["files"][0]
    assert row["doc_type"] == "id_copy"
    assert row["extracted"] == {}
    assert row["confidences"] == {}


# ── /submit persistence + GHL push ─────────────────────────────────────
@pytest.mark.asyncio
async def test_submit_persists_extracted_data_and_pushes_canonical_ghl(
    client, db, admin_headers,
):
    """Full happy path: submit a payload with main + supporting
    extractions. application_extracted_data must carry the merged
    per-doc dict, the conflict detector must surface the name
    mismatch, and GHL must receive the canonical-field push."""
    payload = {
        "contact_id": "C-1",
        "product_type": "medsupp",
        "extracted": {"medsupp_carrier": "Aetna"},
        "contact_name": "Jane Doe",
        "main_extracted": {
            "applicant_full_name": "Jane Doe",
            "applicant_dob": "1955-04-15",
            "applicant_medicare_id": "1EG4-TE5-MK72",
            "plan_name": "Aetna Plan G",
            "carrier": "Aetna",
            "effective_date": "2026-06-01",
            "agent_npn": "98765",
        },
        "main_confidences": {
            "applicant_full_name": 0.95,
            "applicant_dob": 0.92,
            "plan_name": 0.9,
        },
        "supporting_documents": [
            {
                "file_id": "sd-1", "filename": "id.pdf",
                "file_label": "ID Copy", "doc_type": "id_copy",
                "s3_url": "", "s3_key": "",
                "size_bytes": 1024, "content_type": "application/pdf",
                "extracted": {
                    "full_name": "Jane M Doe",
                    "medicare_beneficiary_id": "1EG4-TE5-MK72",
                },
                "confidences": {
                    "full_name": 0.95,
                    "medicare_beneficiary_id": 0.95,
                },
            },
        ],
    }
    r = client.post("/api/applications/submit",
                    headers=admin_headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["extracted_doc_count"] == 2
    # Conflict on full_name (main has "Jane Doe", id_copy has "Jane M Doe").
    assert body["conflict_count"] >= 1
    assert body["ghl_canonical_pushed"] >= 4

    row = await db["application_extracted_data"].find_one(
        {"lead_id": body["lead_id"]},
    )
    assert row is not None
    assert row["by_doc"]["main_application"]["applicant_full_name"] == "Jane Doe"
    assert row["by_doc"]["id_copy"]["medicare_beneficiary_id"] == "1EG4-TE5-MK72"
    conflict_names = [c["canonical"] for c in row["conflicts"]]
    assert "full_name" in conflict_names


# ── /extracted-data/{lead_id} read-back ────────────────────────────────
@pytest.mark.asyncio
async def test_get_extracted_data_returns_most_recent(client, db, admin_headers):
    """Two submissions for the same lead — the read endpoint must
    return the latest one."""
    # Seed two rows. Use ISO strings so the sort matches what the
    # submit handler writes.
    await db["application_extracted_data"].insert_many([
        {
            "submission_id": "p-old", "lead_id": "lead-X",
            "agent_id": "anyone",
            "by_doc": {"main_application": {"plan_name": "Old Plan"}},
            "confidences_by_doc": {}, "conflicts": [],
            "supporting_summaries": [],
            "created_at": "2026-01-01T00:00:00+00:00",
        },
        {
            "submission_id": "p-new", "lead_id": "lead-X",
            "agent_id": "anyone",
            "by_doc": {"main_application": {"plan_name": "New Plan"}},
            "confidences_by_doc": {}, "conflicts": [],
            "supporting_summaries": [],
            "created_at": "2026-05-20T00:00:00+00:00",
        },
    ])
    r = client.get("/api/applications/extracted-data/lead-X",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["empty"] is False
    assert body["submission_id"] == "p-new"


def test_get_extracted_data_empty_state(client, admin_headers):
    """No submissions for this lead → endpoint returns ``empty: true``
    rather than 404, so the SPA tab can render its zero state."""
    r = client.get("/api/applications/extracted-data/never-submitted",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["empty"] is True
    assert body["by_doc"] == {}
