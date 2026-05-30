"""Array-length caps on Lead / LeadBase fields.

Prevents unbounded array growth inside a single Mongo doc. Pydantic v2
`Field(max_length=N)` on a List enforces the constraint at model
construction time — FastAPI surfaces that as a 422 at the route layer.

One test per capped field. Each test checks both edges of the boundary:
the at-cap payload still constructs, and at-cap + 1 raises.
"""
import pytest
from pydantic import ValidationError

from models import LeadCreate, Lead


def _base():
    return {"first_name": "Test", "last_name": "User"}


def test_lead_tags_capped_at_50():
    at_cap = [f"tag-{i}" for i in range(50)]
    assert len(LeadCreate(**_base(), tags=at_cap).tags) == 50

    over_cap = [f"tag-{i}" for i in range(51)]
    with pytest.raises(ValidationError):
        LeadCreate(**_base(), tags=over_cap)


def test_lead_doctors_capped_at_20():
    at_cap = [f"Dr. {i}" for i in range(20)]
    assert len(LeadCreate(**_base(), doctors=at_cap).doctors) == 20

    over_cap = [f"Dr. {i}" for i in range(21)]
    with pytest.raises(ValidationError):
        LeadCreate(**_base(), doctors=over_cap)


def test_lead_prescriptions_capped_at_50():
    at_cap = [f"rx-{i}" for i in range(50)]
    assert len(LeadCreate(**_base(), prescriptions=at_cap).prescriptions) == 50

    over_cap = [f"rx-{i}" for i in range(51)]
    with pytest.raises(ValidationError):
        LeadCreate(**_base(), prescriptions=over_cap)


def test_lead_document_ids_capped_at_500():
    # document_ids is defined on Lead, not LeadBase / LeadCreate.
    at_cap = [f"doc-{i}" for i in range(500)]
    assert len(Lead(**_base(), document_ids=at_cap).document_ids) == 500

    over_cap = [f"doc-{i}" for i in range(501)]
    with pytest.raises(ValidationError):
        Lead(**_base(), document_ids=over_cap)
