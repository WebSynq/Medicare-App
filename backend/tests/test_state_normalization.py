"""State field normalization on LeadBase.

Single enforcement point — any API path, CSV import, or webhook that
builds a Lead through LeadBase / LeadCreate runs through the validator.
Tests exercise LeadCreate (the public-facing payload model) so they
cover the same surface real callers see.
"""
import pytest

from models import LeadCreate


def _state(value):
    """Build a minimal LeadCreate and return the normalized state."""
    lead = LeadCreate(first_name="Test", last_name="User", state=value)
    return lead.state


def test_state_uppercase_passthrough():
    assert _state("IL") == "IL"


def test_state_lowercase_normalizes():
    assert _state("il") == "IL"


def test_state_mixed_case_normalizes():
    assert _state("Il") == "IL"


def test_state_full_name_illinois():
    assert _state("Illinois") == "IL"


def test_state_full_name_illinois_lowercase():
    assert _state("illinois") == "IL"


def test_state_full_name_tennessee():
    assert _state("Tennessee") == "TN"


def test_state_full_name_new_york():
    assert _state("New York") == "NY"


def test_state_none_passthrough():
    assert _state(None) is None


def test_state_unknown_uppercased():
    # Best-effort: unknown values are uppercased rather than rejected
    # so a typo doesn't 422 the entire intake flow.
    assert _state("xyz") == "XYZ"


def test_state_whitespace_stripped():
    assert _state("  IL  ") == "IL"


# A few extra cases worth pinning down so the validator's contract
# stays stable as we add more state-aware features.
def test_state_full_name_with_extra_whitespace():
    assert _state("  illinois  ") == "IL"


def test_state_empty_string_treated_as_none():
    assert _state("") is None


def test_state_all_50_full_names_map_correctly():
    """Full sweep of the map so a future name edit can't silently rot
    one of the 50 entries."""
    cases = {
        "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
        "california": "CA", "colorado": "CO", "connecticut": "CT",
        "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI",
        "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
        "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
        "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
        "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
        "montana": "MT", "nebraska": "NE", "nevada": "NV",
        "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
        "new york": "NY", "north carolina": "NC", "north dakota": "ND",
        "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
        "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
        "south dakota": "SD", "tennessee": "TN", "texas": "TX",
        "utah": "UT", "vermont": "VT", "virginia": "VA",
        "washington": "WA", "west virginia": "WV", "wisconsin": "WI",
        "wyoming": "WY",
    }
    for full, code in cases.items():
        assert _state(full) == code, f"{full!r} → expected {code}, got {_state(full)!r}"
