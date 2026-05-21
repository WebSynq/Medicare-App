"""Multi-file supporting-document upload validation.

These tests exercise POST /api/applications/upload-supporting end-to-end
through TestClient. S3 isn't configured in tests, so the helper short-
circuits to empty ``s3_url`` — that's intentional: the test asserts the
*validation* contract, not the bucket round-trip."""
import json

import pytest


PDF_BYTES = b"%PDF-1.4\n%test\nfake-pdf-payload\nstream\nendstream\n%%EOF\n"
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n"
    + b"\x00" * 64  # arbitrary body; magic byte prefix is what we check
)
JPG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 64


# ── Happy path: PDF + JPG + PNG, mixed labels ──────────────────────────────
def test_supporting_upload_accepts_pdf_jpg_png(client, admin_headers):
    files = [
        ("files", ("policy.pdf", PDF_BYTES, "application/pdf")),
        ("files", ("id.jpg", JPG_BYTES, "image/jpeg")),
        ("files", ("eft.png", PNG_BYTES, "image/png")),
    ]
    labels = json.dumps(["SOA", "ID Copy", "EFT Form"])
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        data={"labels": labels, "contact_id": "C-1"},
        files=files,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 3
    assert {f["file_label"] for f in body["files"]} == {"SOA", "ID Copy", "EFT Form"}
    sizes = {f["filename"]: f["size_bytes"] for f in body["files"]}
    assert sizes["policy.pdf"] == len(PDF_BYTES)
    assert sizes["id.jpg"] == len(JPG_BYTES)
    assert sizes["eft.png"] == len(PNG_BYTES)


# ── Rejects: per-file > 10 MB ─────────────────────────────────────────────
def test_supporting_upload_rejects_oversize_file(client, admin_headers):
    big = b"%PDF-" + b"\x00" * (10 * 1024 * 1024 + 100)  # >10MB
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        files=[("files", ("big.pdf", big, "application/pdf"))],
    )
    assert r.status_code == 413, r.text
    assert "10 MB" in r.json()["detail"] or "10MB" in r.json()["detail"]


# ── Rejects: batch sum > 50 MB ────────────────────────────────────────────
def test_supporting_upload_rejects_oversize_batch(client, admin_headers):
    """Six 9 MB files sum to 54 MB → exceeds the 50 MB batch cap."""
    chunk = b"%PDF-" + b"\x00" * (9 * 1024 * 1024)  # ~9 MB each
    files = [("files", (f"doc{i}.pdf", chunk, "application/pdf")) for i in range(6)]
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        files=files,
    )
    assert r.status_code == 413, r.text
    assert "50 MB" in r.json()["detail"] or "50MB" in r.json()["detail"]


# ── Rejects: > 10 files ───────────────────────────────────────────────────
def test_supporting_upload_rejects_too_many_files(client, admin_headers):
    files = [
        ("files", (f"doc{i}.pdf", PDF_BYTES, "application/pdf"))
        for i in range(11)
    ]
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        files=files,
    )
    assert r.status_code == 400, r.text
    assert "10 files" in r.json()["detail"]


# ── Rejects: extension/magic mismatch (renamed binary) ───────────────────
def test_supporting_upload_rejects_bad_magic_bytes(client, admin_headers):
    """A binary blob with a .pdf extension but missing the %PDF- prefix
    is rejected by the magic-byte cross-check."""
    not_a_pdf = b"\x00\x01\x02\x03not really a pdf"
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        files=[("files", ("fake.pdf", not_a_pdf, "application/pdf"))],
    )
    assert r.status_code == 415, r.text
    assert "magic-byte" in r.json()["detail"] or "match" in r.json()["detail"]


# ── Rejects: unsupported extension ────────────────────────────────────────
def test_supporting_upload_rejects_unsupported_extension(client, admin_headers):
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        files=[("files", ("config.txt", b"hello", "text/plain"))],
    )
    assert r.status_code == 415, r.text
    assert "Accepted formats" in r.json()["detail"]


# ── Labels: bad label coerced to "Other" ──────────────────────────────────
def test_supporting_upload_coerces_unknown_label(client, admin_headers):
    r = client.post(
        "/api/applications/upload-supporting",
        headers=admin_headers,
        data={"labels": json.dumps(["FooBar"])},
        files=[("files", ("a.pdf", PDF_BYTES, "application/pdf"))],
    )
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["file_label"] == "Other"


# ── Submit persists supporting_documents into the policies row ───────────
@pytest.mark.asyncio
async def test_submit_persists_supporting_documents(client, db, admin_headers):
    payload = {
        "contact_id": "",
        "product_type": "medsupp",
        "extracted": {
            "first_name": "Multi", "last_name": "Docs",
            "email": "multi.docs@example.com",
            "phone": "555-1212",
        },
        "contact_name": "Multi Docs",
        "supporting_documents": [
            {
                "file_id": "id-1", "filename": "soa.pdf",
                "file_label": "SOA", "s3_url": "https://b.s3/a/soa.pdf",
                "s3_key": "a/soa.pdf", "size_bytes": 1234,
                "content_type": "application/pdf",
            },
            {
                "file_id": "id-2", "filename": "id.jpg",
                "file_label": "ID Copy", "s3_url": "",
                "s3_key": "", "size_bytes": 9999,
                "content_type": "image/jpeg",
            },
        ],
    }
    r = client.post("/api/applications/submit",
                    headers=admin_headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    pol = await db.policies.find_one({"lead_id": body["lead_id"]})
    assert pol is not None
    docs = pol.get("supporting_documents") or []
    assert len(docs) == 2
    labels = {d["file_label"] for d in docs}
    assert labels == {"SOA", "ID Copy"}


# ── Submit caps supporting documents at 9 (1 primary + 9 supporting = 10) ──
def test_submit_rejects_too_many_supporting(client, admin_headers):
    payload = {
        "contact_id": "",
        "product_type": "medsupp",
        "extracted": {"first_name": "Too", "last_name": "Many"},
        "contact_name": "Too Many",
        "supporting_documents": [
            {"filename": f"d{i}.pdf", "file_label": "Other",
             "s3_url": "", "size_bytes": 100,
             "content_type": "application/pdf"}
            for i in range(10)  # 10 supporting + 1 implicit primary = 11
        ],
    }
    r = client.post("/api/applications/submit",
                    headers=admin_headers, json=payload)
    assert r.status_code == 400, r.text
    assert "supporting documents" in r.json()["detail"].lower()


# ── Submit caps total bytes at 50 MB ──────────────────────────────────────
def test_submit_rejects_50mb_over_total(client, admin_headers):
    payload = {
        "contact_id": "",
        "product_type": "medsupp",
        "extracted": {"first_name": "Bytes", "last_name": "Over"},
        "contact_name": "Bytes Over",
        "supporting_documents": [
            {"filename": "big.pdf", "file_label": "Other",
             "s3_url": "", "size_bytes": 60 * 1024 * 1024,
             "content_type": "application/pdf"},
        ],
    }
    r = client.post("/api/applications/submit",
                    headers=admin_headers, json=payload)
    assert r.status_code == 413, r.text
    assert "50 MB" in r.json()["detail"] or "50MB" in r.json()["detail"]
