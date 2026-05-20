"""
commission_calculator.py
========================
GHW commission rate engine.

Rate data is transcribed from GHW Comm Sch.xlsx. Single source of truth
for both the calculator endpoint and any future reconciliation against
production_records. Lives in code (not Mongo) on purpose — these rates
change infrequently and need to be reviewable in git.

Formula
-------
For percentage-based contracts:
    annual_premium  = monthly_premium * 12
    agency_revenue  = annual_premium * carrier_rate
    agent_split     = AGENT_SPLIT_PCT          (30%)
    agent_commission = agency_revenue * agent_split

For flat-dollar contracts (UHC Med Supp, MA, PDP):
    agency_revenue   = flat_dollar_amount
    agent_commission = agency_revenue * agent_split
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set


# ── Constants ─────────────────────────────────────────────────────────────
AGENT_SPLIT_PCT = 0.30  # Agent receives 30% of agency revenue.

# Product type codes used throughout the API and frontend dropdowns.
PRODUCT_TYPES = [
    "med_supp", "ma", "pdp",
    "cancer", "heart_stroke", "cancer_heart_stroke",
    "hip", "rc", "dvh", "dvh_plus", "stc", "hhc",
    "final_expense", "dental", "annuity", "life",
]

# Carrier display names by product family — drives the dropdowns.
CARRIERS_BY_PRODUCT = {
    "med_supp": [
        "Bankers Fidelity", "Aetna", "Aflac", "ABL",
        "Wellabe", "MOO", "UHC", "Cigna",
    ],
    "ma": ["Aetna", "Humana", "UHC", "Wellcare", "Anthem", "Cigna"],
    "pdp": ["Aetna", "Humana", "UHC", "Wellcare"],
    "cancer": ["Aetna", "Liberty Bankers", "Heartland", "Wellabe"],
    "heart_stroke": ["Aetna", "Liberty Bankers", "Heartland", "Wellabe"],
    "cancer_heart_stroke": ["Aetna", "Liberty Bankers", "Heartland"],
    "hip": [
        "Aetna", "Liberty Bankers", "Heartland", "GTL",
        "Wellabe", "Bankers Fidelity",
    ],
    "rc": ["Aetna"],
    "dvh": ["Aetna"],
    "dvh_plus": ["Aetna"],
    "stc": ["Heartland"],
    "hhc": ["Heartland", "GTL"],
    "final_expense": ["Aetna", "Aflac", "MOO", "ABL", "Liberty Bankers"],
    "dental": ["MOO", "Manhattan Life", "Physicians Mutual"],
    "annuity": ["GTL", "Aetna", "MOO"],
    "life": ["Aetna", "MOO", "ABL"],
}

# Plan options for Med Supp + Medicare Advantage.
PLAN_OPTIONS_BY_PRODUCT = {
    "med_supp": ["F", "G", "N"],
    "ma": ["PPO", "HMO", "DSNP"],
    "pdp": ["Standard"],
}


# ── Med Supp rate tables ─────────────────────────────────────────────────
# Each carrier entry is a list of rules. Lookup walks the list in order,
# matches the first rule whose ``states`` includes the request state, and
# pulls the rate for the right (age_band, plan) combination.
#
# Age bands:
#     65-79  → "lo"
#     80+    → "hi"
# Plans:
#     F, G   → fg_<band>
#     N      → n_<band>
@dataclass
class MedSuppRule:
    states: Set[str]
    fg_lo: Optional[float] = None
    n_lo: Optional[float] = None
    fg_hi: Optional[float] = None
    n_hi: Optional[float] = None


def _all_eq(rate: float) -> MedSuppRule:
    """Shorthand: rate applies to every (age, plan) combo."""
    return MedSuppRule(set(), fg_lo=rate, n_lo=rate, fg_hi=rate, n_hi=rate)


# Helper to bind a state set onto an _all_eq rule.
def _flat(states: Set[str], rate: float) -> MedSuppRule:
    r = _all_eq(rate)
    r.states = states
    return r


MED_SUPP_RULES: Dict[str, List[MedSuppRule]] = {
    "Bankers Fidelity": [
        _flat({"DE", "OK", "SD", "WY"}, 0.26),
        _flat({"GA", "TN"}, 0.26),
        MedSuppRule({"IL"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
        _flat({"AL"}, 0.26),
        _flat({"IN"}, 0.23),
        MedSuppRule(
            {"AZ", "AR", "IA", "KS", "MD", "MI", "NJ", "NM",
             "NC", "ND", "OH", "SC", "UT", "VA"},
            fg_lo=0.26, n_lo=0.26, fg_hi=0.155, n_hi=0.155,
        ),
        _flat({"CO", "MT"}, 0.25),
        _flat({"KY"}, 0.25),
        MedSuppRule({"PA"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
        MedSuppRule({"TX"}, fg_lo=0.25, n_lo=0.25, fg_hi=0.0225, n_hi=0.0225),
        MedSuppRule({"WV"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
        MedSuppRule({"LA", "MS"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
    ],
    "Aetna": [
        _flat({"AR", "CA", "DC", "ND", "NH", "NM", "OK", "RI",
               "SD", "UT", "VT", "WY"}, 0.27),
        MedSuppRule(
            {"AL", "AZ", "GA", "IA", "KY", "LA", "MS", "NC",
             "NE", "NJ", "NV", "VA", "WV"},
            fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32,
        ),
        _flat({"AK"}, 0.205),
        _flat({"CO", "MN", "MT", "OR"}, 0.27),
        _flat({"DE"}, 0.27),
        _flat({"FL"}, 0.26),
        MedSuppRule({"ID"}, fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32),
        MedSuppRule({"IL"}, fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32),
        _flat({"IN"}, 0.28),
        MedSuppRule({"KS", "MD"}, fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32),
        MedSuppRule({"MI"}, fg_lo=0.35, n_lo=0.40, fg_hi=0.35, n_hi=0.40),
        _flat({"MO"}, 0.27),
        MedSuppRule({"OH"}, fg_lo=0.36, n_lo=0.31, fg_hi=0.26, n_hi=0.31),
        MedSuppRule({"PA"}, fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32),
        MedSuppRule({"SC", "TN", "TX"},
                    fg_lo=0.27, n_lo=0.32, fg_hi=0.27, n_hi=0.32),
        _flat({"WI"}, 0.27),
    ],
    "Aflac": [
        MedSuppRule(
            {"AL", "AR", "AZ", "GA", "IA", "KY", "LA", "MD", "MS",
             "NE", "NV", "NH", "NM", "NC", "ND", "OK", "RI", "SD",
             "TN", "UT", "VT", "VA", "WV", "WY"},
            fg_lo=0.26, n_lo=0.31, fg_hi=0.13, n_hi=0.155,
        ),
        _flat({"CA"}, 0.105),
        MedSuppRule({"CO"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.175, n_hi=0.175),
        MedSuppRule({"DE", "IL", "KS", "NJ", "PA", "SC", "TX"},
                    fg_lo=0.26, n_lo=0.31, fg_hi=0.13, n_hi=0.155),
        # FL is N-only — fg fields left None so a Plan-F lookup returns None.
        MedSuppRule({"FL"}, n_lo=0.25, n_hi=0.125),
        _flat({"ID", "OR"}, 0.105),
        _flat({"IN"}, 0.27),
        MedSuppRule({"MI"}, fg_lo=0.34, n_lo=0.39, fg_hi=0.17, n_hi=0.195),
        _flat({"MO"}, 0.105),
        _flat({"MT"}, 0.26),
        MedSuppRule({"OH"}, fg_lo=0.25, n_lo=0.30, fg_hi=0.13, n_hi=0.15),
        MedSuppRule({"WI"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
    ],
    "ABL": [
        MedSuppRule(
            {"AL", "AZ", "GA", "IA", "KY", "LA", "MD", "MS", "NH",
             "NJ", "NM", "ND", "RI", "SD", "UT", "VT", "VA", "WV", "WY"},
            fg_lo=0.26, n_lo=0.31, fg_hi=0.13, n_hi=0.155,
        ),
        MedSuppRule({"AR"}, fg_lo=0.23, n_lo=0.27, fg_hi=0.115, n_hi=0.135),
        MedSuppRule({"DE", "FL"},
                    fg_lo=0.31, n_lo=0.26, fg_hi=0.155, n_hi=0.13),
        MedSuppRule({"IA", "IL", "KS", "OK"},
                    fg_lo=0.24, n_lo=0.29, fg_hi=0.11, n_hi=0.135),
        MedSuppRule({"OH", "SC"},
                    fg_lo=0.0155, n_lo=0.26, fg_hi=0.007, n_hi=0.13),
        MedSuppRule({"NV"}, fg_lo=0.16, n_lo=0.21, fg_hi=0.03, n_hi=0.055),
        MedSuppRule({"NE"}, fg_lo=0.16, n_lo=0.21, fg_hi=0.03, n_hi=0.0),
        MedSuppRule({"NC", "PA", "TN", "TX"},
                    fg_lo=0.26, n_lo=0.31, fg_hi=0.13, n_hi=0.155),
        _flat({"IN"}, 0.25),
        MedSuppRule({"MI"},
                    fg_lo=0.0155, n_lo=0.26, fg_hi=0.007, n_hi=0.08),
        MedSuppRule({"WI"}, fg_lo=0.26, n_lo=0.26, fg_hi=0.13, n_hi=0.13),
    ],
    "Wellabe": [
        MedSuppRule({"AL", "IA", "NE", "OH", "UT", "WV"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.135, n_hi=0.155),
        MedSuppRule({"AZ", "NH", "SC"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.2075, n_hi=0.2375),
        _flat({"AR"}, 0.24),
        _flat({"CO"}, 0.27),
        MedSuppRule({"DE", "NC"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.2075, n_hi=0.2375),
        MedSuppRule({"FL"},
                    fg_lo=0.23, n_lo=0.27, fg_hi=0.1775, n_hi=0.2075),
        MedSuppRule({"GA", "NJ", "TX"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.2075, n_hi=0.2375),
        MedSuppRule({"KS", "IL"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.135, n_hi=0.155),
        _flat({"IN"}, 0.285),
        MedSuppRule({"KY", "MD"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.2075, n_hi=0.2375),
        MedSuppRule({"LA", "VA"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.135, n_hi=0.155),
        MedSuppRule({"MI"},
                    fg_lo=0.275, n_lo=0.295, fg_hi=0.18, n_hi=0.195),
        _flat({"MO"}, 0.22),
        MedSuppRule({"PA", "TN"},
                    fg_lo=0.27, n_lo=0.31, fg_hi=0.2075, n_hi=0.2375),
        _flat({"WA"}, 0.07),
        MedSuppRule({"WI"}, fg_lo=0.27, n_lo=0.27, fg_hi=0.135, n_hi=0.135),
    ],
    "MOO": [
        MedSuppRule({"AL", "UT"},
                    fg_lo=0.25, n_lo=0.29, fg_hi=0.125, n_hi=0.145),
        MedSuppRule({"CO"},
                    fg_lo=0.225, n_lo=0.265, fg_hi=0.225, n_hi=0.265),
        MedSuppRule({"CT"},
                    fg_lo=0.16, n_lo=0.20, fg_hi=0.0215, n_hi=0.0425),
        MedSuppRule({"ID"},
                    fg_lo=0.25, n_lo=0.29, fg_hi=0.25, n_hi=0.29),
        MedSuppRule(
            {"IL", "KS", "LA", "MN", "NM", "NC", "WI", "NE",
             "TN", "TX", "DE", "KY", "MD", "MS", "NH", "NJ", "VT"},
            fg_lo=0.25, n_lo=0.29, fg_hi=0.125, n_hi=0.145,
        ),
        MedSuppRule({"NV"},
                    fg_lo=0.195, n_lo=0.235, fg_hi=0.0975, n_hi=0.1175),
        MedSuppRule({"MI"},
                    fg_lo=0.32, n_lo=0.354, fg_hi=0.16, n_hi=0.177),
        MedSuppRule({"OH", "IN"},
                    fg_lo=0.24, n_lo=0.275, fg_hi=0.12, n_hi=0.1375),
        MedSuppRule({"ME"},
                    fg_lo=0.215, n_lo=0.255, fg_hi=0.125, n_hi=0.255),
        MedSuppRule({"PA"},
                    fg_lo=0.235, n_lo=0.275, fg_hi=0.235, n_hi=0.275),
        MedSuppRule({"RI"},
                    fg_lo=0.25, n_lo=0.29, fg_hi=0.25, n_hi=0.29),
        MedSuppRule({"CA"},
                    fg_lo=0.215, n_lo=0.255, fg_hi=0.1075, n_hi=0.1275),
        MedSuppRule({"FL"},
                    fg_lo=0.21, n_lo=0.21, fg_hi=0.1365, n_hi=0.1365),
        MedSuppRule({"MO"},
                    fg_lo=0.205, n_lo=0.245, fg_hi=0.205, n_hi=0.245),
        MedSuppRule({"OR"},
                    fg_lo=0.195, n_lo=0.235, fg_hi=0.195, n_hi=0.235),
        _flat({"WA"}, 0.13),
    ],
    "Cigna": [
        # Cigna pays a flat 25% in every state, all age bands, all plans.
        MedSuppRule(
            states={
                "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL",
                "GA", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA",
                "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE",
                "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI",
                "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY",
            },
            fg_lo=0.25, n_lo=0.25, fg_hi=0.25, n_hi=0.25,
        ),
    ],
}


# ── UHC Med Supp flat-dollar table ───────────────────────────────────────
# UHC pays a flat amount per year per policy (in addition to a few states
# with explicit values, WA uses 4%).
UHC_FLAT: Dict[str, Dict[str, Any]] = {
    "AL": {"fg": 258.0, "n": 224.0}, "LA": {"fg": 258.0, "n": 224.0},
    "ME": {"fg": 258.0, "n": 224.0}, "NH": {"fg": 258.0, "n": 224.0},
    "AK": {"fg": 176.0, "n": 160.0}, "HI": {"fg": 176.0, "n": 160.0},
    "SD": {"fg": 176.0, "n": 160.0},
    "DC": {"fg": 208.75, "n": 181.0}, "ND": {"fg": 208.75, "n": 181.0},
    "RI": {"fg": 208.75, "n": 181.0}, "WY": {"fg": 208.75, "n": 181.0},
    "MS": {"fg": 403.0, "n": 224.0}, "NE": {"fg": 403.0, "n": 224.0},
    "NV": {"fg": 403.0, "n": 224.0},
    "AR": {"fg": 320.0, "n": 293.25}, "AZ": {"fg": 330.75, "n": 266.75},
    "CA": {"fg": 362.25, "n": 315.0}, "CO": {"fg": 304.5, "n": None},
    "CT": {"fg": 380.0, "n": 224.0}, "DE": {"fg": 246.5, "n": 224.0},
    "FL": {"fg": 480.0, "n": 320.0}, "GA": {"fg": 373.35, "n": 266.75},
    "ID": {"fg": 400.0, "n": 346.75}, "IL": {"fg": 330.0, "n": 277.0},
    "IN": {"fg": 330.75, "n": None}, "IA": {"fg": 305.0, "n": 245.25},
    "KS": {"fg": 293.25, "n": 277.25}, "KY": {"fg": 352.0, "n": 298.75},
    "MD": {"fg": 384.0, "n": 320.0}, "MA": {"fg": 373.25, "n": None},
    "MI": {"fg": 437.25, "n": 373.25}, "MN": {"fg": 399.5, "n": None},
    "MO": {"fg": 488.25, "n": 224.0}, "MT": {"fg": 276.75, "n": None},
    "NC": {"fg": 293.25, "n": 240.0}, "NJ": {"fg": 451.5, "n": 245.0},
    "NY": {"fg": 422.25, "n": 285.0}, "OH": {"fg": 277.25, "n": 261.25},
    "OK": {"fg": 234.0, "n": 203.0}, "OR": {"fg": 426.75, "n": 320.0},
    "PA": {"fg": 378.75, "n": 277.25}, "SC": {"fg": 261.25, "n": 234.75},
    "TN": {"fg": 384.0, "n": 293.25}, "TX": {"fg": 298.75, "n": 266.75},
    "VT": {"fg": 208.75, "n": 194.75},
    "WI": {"fg": 320.0, "n": 245.25}, "WV": {"fg": 282.25, "n": 245.0},
}
UHC_DEFAULT = {"fg": 354.75, "n": 203.0}
UHC_WA_PCT = 0.04  # WA pays 4%, not a flat amount.


# ── Ancillary rates ──────────────────────────────────────────────────────
# Carriers + products bundled together. Each rule lists states + the
# percentage. Lookup falls through rules in order — first match wins.

@dataclass
class AncillaryRule:
    states: Set[str]
    rate: float


ANCILLARY_RULES: Dict[str, Dict[str, List[AncillaryRule]]] = {
    "Aetna": {
        "cancer": [
            AncillaryRule(
                {"AL", "AR", "CA", "GA", "IA", "ID", "IL", "KS", "KY",
                 "LA", "MO", "MS", "MT", "NC", "NE", "NH", "NM", "NV",
                 "OK", "OR", "PA", "RI", "TN", "TX", "VA", "WI", "WV"},
                1.085),
            AncillaryRule(
                {"AZ", "DE", "FL", "IN", "MI", "ND", "OH", "SC", "UT", "VT"},
                1.02),
            AncillaryRule(
                {"CO", "CT", "MA", "MD", "MN", "NJ", "SD", "WA", "WY"},
                0.99),
        ],
        "dvh": [
            AncillaryRule({"NM"}, 0.415),
            AncillaryRule({"CO", "SD"}, 0.39),
            AncillaryRule({"RI"}, 0.19),
            AncillaryRule(
                {"AL", "AR", "AZ", "CA", "CT", "DC", "DE", "FL", "GA",
                 "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD",
                 "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH",
                 "NJ", "NV", "OH", "OK", "OR", "PA", "SC", "TN", "TX",
                 "UT", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.59),
        ],
        "hip": [
            AncillaryRule(
                {"AL", "AR", "CA", "DE", "GA", "ID", "IL", "IN", "KS",
                 "KY", "LA", "MN", "MS", "MT", "NC", "NE", "NM", "NV",
                 "OH", "OK", "OR", "PA", "TN", "TX", "WI", "WV", "WY"},
                0.675),
            AncillaryRule(
                {"AZ", "CT", "FL", "IA", "MA", "MD", "MI", "ND", "NH",
                 "SC", "UT", "VA", "VT"},
                0.62),
            AncillaryRule(
                {"CO", "NJ", "RI", "SD", "WA"},
                0.62),
        ],
        "rc": [
            AncillaryRule({"AZ", "DE", "MD", "MI", "SC", "UT", "CO",
                           "KY", "RI", "SD"},
                          0.62),
            AncillaryRule({"ND"}, 0.17),
            AncillaryRule(
                {"AL", "AR", "CA", "FL", "GA", "IA", "ID", "IL", "IN",
                 "KS", "LA", "MA", "MN", "MO", "MS", "MT", "NC", "NE",
                 "NH", "NJ", "NM", "NV", "OH", "OK", "OR", "PA", "TN",
                 "TX", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.675),
        ],
    },
    "Liberty Bankers": {
        "hip": [
            AncillaryRule(
                {"AL", "AR", "DE", "FL", "GA", "IA", "ID", "IL", "KS",
                 "LA", "MO", "MS", "MT", "NE", "NC", "NM", "NV", "OK",
                 "OR", "PA", "RI", "TX", "UT", "WI", "WV", "WY"},
                0.825),
            AncillaryRule(
                {"AZ", "CO", "DC", "IN", "KY", "MD", "MI", "ND", "OH",
                 "SC", "TN", "VA"},
                0.725),
            AncillaryRule({"SD", "WA"}, 0.60),
            AncillaryRule({"NJ"}, 0.575),
        ],
        "cancer": [
            AncillaryRule(
                {"AL", "AR", "DE", "FL", "GA", "IA", "ID", "IL", "KS",
                 "LA", "MO", "MS", "MT", "NE", "NC", "NM", "NV", "OK",
                 "OR", "PA", "RI", "TX", "UT", "WI", "WV", "WY"},
                0.825),
            AncillaryRule(
                {"AZ", "CO", "DC", "IN", "KY", "MD", "MI", "ND", "OH",
                 "SC", "TN", "VA"},
                0.725),
            AncillaryRule({"SD", "WA"}, 0.60),
            AncillaryRule({"NJ"}, 0.575),
        ],
    },
    "Heartland": {
        "cancer": [
            AncillaryRule(
                {"AL", "AR", "CO", "DE", "GA", "IA", "IL", "KS", "KY",
                 "LA", "MO", "MS", "NC", "ND", "NE", "NV", "OH", "OK",
                 "OR", "SC", "TN", "TX", "WV"},
                1.10),
            AncillaryRule({"MD", "SD"}, 0.95),
        ],
        "heart_stroke": [
            AncillaryRule(
                {"AL", "AR", "CO", "DE", "GA", "IA", "IL", "KS", "KY",
                 "LA", "MO", "MS", "NC", "ND", "NE", "NV", "OH", "OK",
                 "OR", "SC", "TN", "TX", "WV"},
                1.10),
            AncillaryRule({"MD", "SD"}, 0.95),
        ],
        "stc": [
            AncillaryRule({"SD"}, 0.75),
            AncillaryRule(
                {"AL", "AR", "AZ", "CO", "CT", "DE", "FL", "GA", "IA",
                 "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "MI",
                 "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ",
                 "NM", "NV", "OH", "OK", "OR", "PA", "RI", "SC", "TN",
                 "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.85),
        ],
        "hhc": [
            AncillaryRule({"SD"}, 0.75),
            AncillaryRule(
                {"AL", "AR", "AZ", "CO", "CT", "DE", "FL", "GA", "IA",
                 "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "MI",
                 "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ",
                 "NM", "NV", "OH", "OK", "OR", "PA", "RI", "SC", "TN",
                 "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.85),
        ],
        "hip": [
            AncillaryRule(
                {"AL", "AK", "AR", "DE", "GA", "HI", "IL", "IA", "KS",
                 "LA", "MS", "MO", "NV", "NM", "NC", "OK", "OR", "PA",
                 "TX", "UT", "WV"},
                0.80),
            AncillaryRule(
                {"AZ", "FL", "IN", "KY", "MD", "MT", "NE", "ND", "OH",
                 "SC", "TN", "VA"},
                0.75),
            AncillaryRule({"CO", "SD", "WY"}, 0.65),
        ],
    },
    "GTL": {
        "hip": [
            AncillaryRule({"CT", "KS"}, 0.725),
            AncillaryRule({"AZ", "IN", "KY", "MA", "MI", "ND", "VA"}, 0.725),
            AncillaryRule({"SD", "WA"}, 0.725),
            AncillaryRule({"NJ"}, 0.675),
            AncillaryRule({"MN"}, 0.75),
            AncillaryRule(
                {"AL", "AR", "CA", "CO", "DC", "DE", "FL", "GA", "IA",
                 "ID", "IL", "LA", "MD", "ME", "MO", "MS", "MT", "NC",
                 "NE", "NH", "NM", "NV", "OH", "OK", "OR", "PA", "RI",
                 "SC", "TN", "TX", "UT", "VT", "WI", "WV", "WY"},
                0.775),
        ],
        "cancer": [
            AncillaryRule({"CT"}, 0.625),
            AncillaryRule({"MA"}, 0.595),
            AncillaryRule(
                {"AL", "AR", "AZ", "CA", "CO", "DC", "DE", "FL", "GA",
                 "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MD", "ME",
                 "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH",
                 "NJ", "NM", "NV", "OH", "OK", "OR", "PA", "RI", "SC",
                 "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.675),
        ],
        "hhc": [
            AncillaryRule(
                {"AL", "AR", "AZ", "CO", "CT", "DE", "FL", "GA", "IA",
                 "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "MI",
                 "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ",
                 "NM", "NV", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
                 "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"},
                0.85),
        ],
    },
    "Wellabe": {
        "hip": [
            AncillaryRule(
                {"AL", "AR", "GA", "IL", "IA", "KS", "LA", "MS", "MO",
                 "MT", "NE", "NV", "NC", "OK", "OR", "PA", "TN", "TX",
                 "UT", "WV", "WI", "WY"},
                0.70),
            AncillaryRule(
                {"AZ", "FL", "IN", "KY", "MI", "OH", "SC", "VA"}, 0.58),
            AncillaryRule({"CO", "MN", "WA"}, 0.49),
        ],
        "cancer": [
            AncillaryRule(
                {"AL", "AZ", "AR", "GA", "ID", "IL", "IN", "IA", "KS",
                 "KY", "LA", "ME", "MO", "MT", "NE", "NV", "NC", "OH",
                 "OK", "OR", "PA", "SC", "TN", "TX", "UT", "WI", "WY"},
                0.65),
            AncillaryRule({"WA"}, 0.48),
            AncillaryRule({"MI"}, 0.65),
        ],
    },
    "Bankers Fidelity": {
        "hip": [
            AncillaryRule(
                {"CO", "IN", "KY", "MA", "MI", "MN", "ND", "SC", "SD",
                 "TN", "UT", "VA", "WA"},
                0.595),
            AncillaryRule(
                {"AL", "AK", "AR", "AZ", "CA", "CT", "DC", "DE", "FL",
                 "GA", "HI", "IA", "ID", "IL", "KS", "LA", "MD", "ME",
                 "MO", "MS", "MT", "NC", "NE", "NH", "NJ", "NM", "NV",
                 "NY", "OH", "OK", "OR", "PA", "RI", "TX", "VT", "WI",
                 "WV", "WY"},
                0.745),
        ],
    },
}


# ── Flat-dollar / simple percentage products ─────────────────────────────
# These don't depend on state — single rate everywhere.
FINAL_EXPENSE_RATE = 0.015  # 1.5% all carriers, all states.
DENTAL_RATES = {  # by carrier (state-agnostic)
    "MOO": 0.45,
    "Manhattan Life": 0.40,
    "Physicians Mutual": 0.35,
}
MA_NEW = 313.0          # flat $ per policy, no scope
MA_WITH_SCOPE = 626.0   # flat $ per policy, scope completed
PDP_FLAT = 100.0        # flat $ per policy


# ── Public API ───────────────────────────────────────────────────────────
def _band(age: int) -> str:
    return "hi" if age >= 80 else "lo"


def _is_fg(plan: Optional[str]) -> bool:
    p = (plan or "").upper().strip()
    return p in ("F", "G")


def _is_n(plan: Optional[str]) -> bool:
    return (plan or "").upper().strip() == "N"


def get_med_supp_rate(
    carrier: str,
    state: str,
    age: int,
    plan: str,
) -> Optional[float]:
    """Return the agency commission percentage for a Med Supp policy.

    Returns ``None`` when no rule matches the (carrier, state, plan)
    combination — the caller must surface this to the user as a
    "rate not found" note rather than silently calculate as zero.
    """
    carrier = (carrier or "").strip()
    state = (state or "").strip().upper()
    if not carrier or not state:
        return None

    # UHC is flat-dollar everywhere except WA → caller should use
    # get_med_supp_flat_dollar(); we still expose a percentage for WA.
    if carrier.upper() == "UHC":
        if state == "WA":
            return UHC_WA_PCT
        return None

    rules = MED_SUPP_RULES.get(carrier)
    if not rules:
        return None
    band = _band(age)
    for rule in rules:
        if state not in rule.states:
            continue
        if _is_fg(plan):
            val = rule.fg_lo if band == "lo" else rule.fg_hi
        elif _is_n(plan):
            val = rule.n_lo if band == "lo" else rule.n_hi
        else:
            val = None
        return val
    return None


def get_med_supp_flat_dollar(
    state: str, plan: str,
) -> Optional[float]:
    """UHC pays a flat annual dollar amount per Med Supp policy.

    Returns the agency-revenue dollar figure (not a percentage), or
    ``None`` if the (state, plan) combo has no payout configured.
    """
    state = (state or "").strip().upper()
    if state == "WA":
        return None  # WA is percentage-based — use get_med_supp_rate
    entry = UHC_FLAT.get(state, UHC_DEFAULT)
    if _is_fg(plan):
        return entry.get("fg")
    if _is_n(plan):
        return entry.get("n")
    return None


def get_ancillary_rate(
    carrier: str, product: str, state: str,
) -> Optional[float]:
    """Return the agency commission percentage for an ancillary
    product. ``product`` is the lowercase short code: ``"cancer"``,
    ``"heart_stroke"``, ``"hip"``, ``"rc"``, ``"dvh"``, ``"dvh_plus"``,
    ``"stc"``, ``"hhc"``."""
    carrier_rules = ANCILLARY_RULES.get((carrier or "").strip())
    if not carrier_rules:
        return None
    product_key = (product or "").strip().lower()
    # dvh_plus inherits dvh's rate table by convention.
    if product_key == "dvh_plus" and "dvh_plus" not in carrier_rules:
        product_key = "dvh"
    # cancer_heart_stroke combines into the cancer schedule when the
    # carrier doesn't list it separately.
    if product_key == "cancer_heart_stroke" and "cancer_heart_stroke" not in carrier_rules:
        product_key = "cancer"
    rules = carrier_rules.get(product_key)
    if not rules:
        return None
    st = (state or "").strip().upper()
    for rule in rules:
        if st in rule.states:
            return rule.rate
    return None


def get_ma_rate(scope_completed: bool) -> float:
    return MA_WITH_SCOPE if scope_completed else MA_NEW


def get_pdp_rate() -> float:
    return PDP_FLAT


def calculate_commission(
    product_type: str,
    carrier: str,
    state: str,
    plan_type: Optional[str],
    monthly_premium: float,
    client_age: int,
    scope_completed: bool = False,
) -> Dict[str, Any]:
    """Public entrypoint used by the API + UI.

    Always returns a dict — even when no rate could be resolved, so the
    caller renders a clear "rate not found for ..." message instead of
    a 500. ``carrier_rate`` is ``None`` in that case; agency_revenue
    and agent_commission fall to 0.0.
    """
    product = (product_type or "").strip().lower()
    monthly = float(monthly_premium or 0)
    annual = round(monthly * 12, 2)
    notes: List[str] = []

    rate: Optional[float] = None
    rate_type = "percentage"
    agency_revenue = 0.0

    if product == "med_supp":
        carrier_norm = (carrier or "").strip()
        if carrier_norm.upper() == "UHC":
            flat = get_med_supp_flat_dollar(state, plan_type or "")
            if state and state.upper() == "WA":
                # UHC WA is a percentage even though every other UHC
                # state is a flat dollar — handle the carve-out.
                rate = UHC_WA_PCT
                rate_type = "percentage"
                agency_revenue = round(annual * rate, 2)
                notes.append("UHC pays 4% in WA (percentage carve-out).")
            elif flat is not None:
                rate = flat
                rate_type = "flat_dollar"
                agency_revenue = round(flat, 2)
                notes.append(
                    f"UHC pays a flat ${flat:,.2f}/yr in {state.upper()} "
                    f"for Plan {plan_type}."
                )
            else:
                notes.append(
                    f"No UHC payout configured for {state}/{plan_type}."
                )
        else:
            rate = get_med_supp_rate(carrier_norm, state, client_age, plan_type or "")
            if rate is None:
                notes.append(
                    f"No {carrier_norm} Med Supp rate found for "
                    f"{state.upper()} (age {client_age}, Plan {plan_type})."
                )
            else:
                agency_revenue = round(annual * rate, 2)

    elif product == "ma":
        rate = get_ma_rate(scope_completed)
        rate_type = "flat_dollar"
        agency_revenue = round(rate, 2)
        notes.append(
            "MA pays a flat $626 per policy when Scope of Appointment "
            "was completed; otherwise $313."
            if scope_completed
            else "MA pays $313 per policy without a completed Scope of Appointment."
        )

    elif product == "pdp":
        rate = get_pdp_rate()
        rate_type = "flat_dollar"
        agency_revenue = round(rate, 2)
        notes.append("PDP pays a flat $100 per policy, all carriers.")

    elif product in ("cancer", "heart_stroke", "cancer_heart_stroke",
                      "hip", "rc", "dvh", "dvh_plus", "stc", "hhc"):
        rate = get_ancillary_rate(carrier, product, state)
        if rate is None:
            notes.append(
                f"No {carrier} {product} rate found for {state.upper()}."
            )
        else:
            agency_revenue = round(annual * rate, 2)

    elif product == "final_expense":
        rate = FINAL_EXPENSE_RATE
        agency_revenue = round(annual * rate, 2)
        notes.append("Final Expense pays 1.5% across all carriers/states.")

    elif product == "dental":
        rate = DENTAL_RATES.get((carrier or "").strip())
        if rate is None:
            notes.append(
                f"No dental rate configured for carrier {carrier!r}."
            )
        else:
            agency_revenue = round(annual * rate, 2)

    elif product in ("annuity", "life"):
        notes.append(
            f"{product.capitalize()} commissions vary by carrier contract — "
            "use the carrier's commission schedule for accuracy."
        )

    else:
        notes.append(f"Unknown product_type: {product_type!r}")

    agent_commission = round(agency_revenue * AGENT_SPLIT_PCT, 2)
    monthly_agent = round(agent_commission / 12, 2) if agency_revenue else 0.0

    return {
        "carrier_rate": rate,
        "rate_type": rate_type,
        "annual_premium": annual,
        "agency_revenue": agency_revenue,
        "agent_split_pct": AGENT_SPLIT_PCT,
        "agent_commission": agent_commission,
        "monthly_agent_commission": monthly_agent,
        "notes": " ".join(notes) if notes else "",
    }
