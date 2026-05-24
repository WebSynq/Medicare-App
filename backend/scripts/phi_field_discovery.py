#!/usr/bin/env python3
"""
phi_field_discovery.py — read-only probe for PHI field locations.

Probes the four candidate collections (leads, clients, policies,
applications, application_extracted_data) for the actual PHI field
names used in this codebase, including nested paths inside
policies.all_fields and application_extracted_data.by_doc.<doc_type>.

Never prints field values; never selects values into the result set
(projection is {"_id": 1} only). Makes NO writes.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/phi_field_discovery.py
"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


# Top-level PHI field names used on flat-schema collections (leads,
# clients, policies, applications). These are the actual canonical
# names in this codebase — `mbi_number` (not `medicare_number`),
# `date_of_birth` (not `dob`). `ssn` / `social_security_number` are
# included as canaries — they should NOT be found anywhere.
TOP_LEVEL_PHI_FIELDS = [
    "mbi_number",
    "medicare_part_a_effective",
    "medicare_part_b_effective",
    "date_of_birth",
    "ssn",
    "social_security_number",
]

# Field names that appear inside untyped sub-documents (policies.all_fields
# and application_extracted_data.by_doc.<doc_type>). These match the
# extraction schema keys in backend/extraction_schemas.py.
NESTED_PHI_FIELDS = [
    "mbi_number",
    "medicare_beneficiary_id",
    "routing_number",
    "account_number",
    "account_holder_name",
    "bank_name",
    "date_of_birth",
    "ssn",
]

# Mirrors DOC_TYPES in backend/extraction_schemas.py — these are the
# dynamic keys under application_extracted_data.by_doc.
DOC_TYPES = [
    "main_application", "soa", "election_notice", "eft_form",
    "phi_auth", "id_copy", "prescriptions", "agent_attestation", "other",
]

# (probe_kind, dotted_path) per collection. probe_kind is informational
# only — every probe runs the same `{path: {"$exists": True}}` query.
COLLECTION_PROBES = {
    "leads":    [("top", f) for f in TOP_LEVEL_PHI_FIELDS],
    "clients":  [("top", f) for f in TOP_LEVEL_PHI_FIELDS],
    "policies": (
        [("top", f) for f in TOP_LEVEL_PHI_FIELDS]
        + [("nested", f"all_fields.{f}") for f in NESTED_PHI_FIELDS]
    ),
    "applications": [("top", f) for f in TOP_LEVEL_PHI_FIELDS],
    "application_extracted_data": [
        ("nested", f"by_doc.{dt}.{f}")
        for dt in DOC_TYPES
        for f in NESTED_PHI_FIELDS
    ],
}

_NAME_PAD = 55  # widest dotted path is ~50 chars


async def _probe(db, coll_name: str, path: str) -> bool:
    """Return True iff any document in coll_name has `path` defined.

    Projection is {"_id": 1} — PHI values are never read.
    """
    doc = await db[coll_name].find_one({path: {"$exists": True}}, {"_id": 1})
    return doc is not None


def _format_line(path: str, present: bool, sample_was_empty: bool) -> str:
    dots = "." * max(2, _NAME_PAD - len(path))
    if sample_was_empty:
        status = "NO DOCUMENTS"
    elif present:
        status = "FOUND"
    else:
        status = "NOT FOUND"
    return f"  {path} {dots} {status}"


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        python backend/scripts/phi_field_discovery.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    existing = set(await db.list_collection_names())

    print()
    print("PHI FIELD DISCOVERY REPORT")
    print("==========================")

    encrypt_targets: dict[str, list[str]] = {}

    for coll_name, probes in COLLECTION_PROBES.items():
        print(f"\nCollection: {coll_name}")
        if coll_name not in existing:
            print("  (collection does not exist — skipped)")
            continue

        total = await db[coll_name].estimated_document_count()
        print(f"  (estimated documents: {total})")
        sample_was_empty = total == 0

        found_paths: list[str] = []

        # For application_extracted_data we only print the FOUND probes
        # (otherwise 72 NOT FOUND lines drown the signal). For every
        # other collection we print all probes so absence is explicit.
        only_print_found = coll_name == "application_extracted_data"

        for _, path in probes:
            present = (not sample_was_empty) and await _probe(db, coll_name, path)
            if only_print_found:
                if present:
                    print(_format_line(path, True, False))
                    found_paths.append(path)
            else:
                print(_format_line(path, present, sample_was_empty))
                if present:
                    found_paths.append(path)

        if only_print_found and not found_paths and not sample_was_empty:
            print("  (no PHI field paths found across "
                  f"{len(probes)} probed nested paths)")

        if found_paths:
            encrypt_targets[coll_name] = found_paths

    print()
    print("==========================")
    print("ENCRYPT THESE PATHS:")
    if not encrypt_targets:
        print("  (none detected)")
    else:
        for coll, paths in encrypt_targets.items():
            print(f"  {coll}:")
            for p in paths:
                print(f"    - {p}")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
