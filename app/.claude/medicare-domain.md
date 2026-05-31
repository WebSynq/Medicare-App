# GHW Medicare Domain Knowledge
# Place this file at: /app/.claude/medicare-domain.md
# Claude Code reads this before writing any Medicare-specific feature.

---

## Enrollment Periods

### AEP — Annual Enrollment Period
- **Dates:** October 15 – December 7, every year
- **What happens:** Beneficiaries can switch/drop Medicare Advantage or Part D plans
- **Effective date:** January 1 of following year
- **Agent impact:** 80% of annual enrollments happen in these 54 days
- **AEP War Room:** Activate Oct 1 – Dec 7. Capacity planning, lead distribution, compliance tripwires

### OEP — Open Enrollment Period  
- **Dates:** January 1 – March 31
- **What happens:** MA enrollees can switch to another MA plan or drop to Original Medicare
- **Effective date:** First day of following month
- **Note:** Cannot switch to a different Supplement plan during OEP

### SEP — Special Enrollment Period
- **Trigger events (most common):**
  - Move to new service area
  - Lose other creditable coverage (employer, Medicaid)
  - LIS (Low Income Subsidy) status change
  - Plan non-renewal or contract termination
  - 5-star plan enrollment (any time, 1x/year)
  - Dual-eligible status change
  - Move to/from nursing facility
- **Window:** Generally 60 days from trigger event
- **CMS RAPS feed:** Medicare beneficiary data changes — source for SEP triggers
- **Agent action:** Must document SEP reason on enrollment form

### Initial Enrollment Period (IEP)
- **Window:** 3 months before, month of, and 3 months after Medicare birthday (Part B)
- **Late enrollment penalty:** 10% per 12-month period delayed for Part B; 1% per month for Part D

---

## Product Types

### Medicare Supplement (Medigap)
- **Key plans:** Plan G (most comprehensive), Plan N (cost-sharing)
- **How it works:** Pays after Original Medicare. No networks.
- **Underwriting:** Required in most states except during Open Enrollment window
- **SOA required:** Yes
- **Commission:** Recurring annual, paid by carrier directly to agent
- **Chargeback window:** Typically 9-12 months if client cancels

### Medicare Advantage (MAPD / MA-PD)
- **How it works:** Replaces Original Medicare. Network-based. Includes Part D.
- **CMS rate:** $313 first year / $626 renewal (GHW current rates)
- **SOA required:** Yes — 48-hour rule applies
- **Commission:** CMS-regulated. Subject to chargeback if client disenrolls within lookback period
- **Lookback period:** 9 months typically. Carrier-specific.

### Part D (PDP — Standalone Prescription Drug Plan)
- **CMS rate:** $100 (GHW current)
- **SOA required:** Yes
- **Late enrollment penalty:** 1% per month delayed × national base premium

### Ancillary Products (GHW Umbrella Packages)
- **Umbrella 1:** Plan G + Cancer/Heart/Stroke (CHS)
- **Umbrella 2:** Plan G + CHS + DVH (Dental/Vision/Hearing)  
- **Umbrella 3:** Plan G + CHS + DVH + Riders/Cancer
- **Carriers:** GTL, Heartland, Medico/Wellabe, ABL, Atlantic Coast Life, Assurity, Manhattan Life, Aflac

---

## CMS Compliance Rules (CRITICAL — Post Oct 2024 Final Rule)

### SOA — Scope of Appointment
- **48-hour rule:** SOA must be signed 48 hours BEFORE the appointment
  - Exception: client initiates contact within 48 hours
  - Exception: AEP walk-ins
- **Required fields:** Products to discuss, client name + signature, date/time, agent NPN
- **Retention:** 10 years
- **Products must match:** Can only discuss products listed on the SOA
- **Digital SOA:** Allowed if compliant e-sign (we use this — SOA workflow in platform)

### TPMO Rule (Third-Party Marketing Organizations)
- **CMS Final Rule Oct 2024:** TPMOs must record ALL marketing/sales calls
- **AI review requirement:** Calls must be reviewed for misleading statements
- **Retention:** 10 years
- **Platform implication:** Call recording + AI compliance scoring is now FEDERAL LAW

### Marketing Rules
- Must not mislead about plan benefits
- Cannot use Medicare logo improperly
- Cannot call beneficiaries without prior express consent (TCPA)
- Must include required disclaimers on all materials

### HIPAA
- PHI = any data that identifies a Medicare beneficiary
- MBI (Medicare Beneficiary Identifier) = PHI — encrypted in our platform
- 7-year audit log retention minimum
- Business Associate Agreements required with all vendors

---

## Birthday Rule (Medigap Switching)

### States With Birthday Rule
Allows Medigap members to switch to equal/lower benefit plan without underwriting:
- **California:** 30 days after birthday
- **Oregon:** 31 days after birthday  
- **Washington:** 30 days before + 30 days after birthday (60-day window)
- **Idaho:** 63 days after birthday
- **Nevada:** 60 days after birthday
- **Oklahoma:** 30 days after birthday
- **Maryland:** 30 days before + 30 days after birthday
- **Missouri:** 30 days after birthday

### Platform Handling
- `birthday_rule_router.py` — three buckets: upcoming, in-window, expired
- Alerts fire at 45 days before DOB for IL-specific rule
- Multi-state birthday rules: Phase 3 follow-up work

---

## Commission Structure (GHW)

### Agent Split
- Agent split = 30% of Agency Revenue
- Agency Revenue = Annual Premium × Carrier Rate

### Rates (GHW Current)
| Product | First Year | Renewal |
|---|---|---|
| Medicare Advantage | $313 | $626 |
| PDP | $100 | $100 |
| UHC | Flat $/state | — |
| Supplement | Varies by carrier + state + age + plan | — |

### Advance vs Earned
- **Advance:** Commission paid upfront on projected 12-month premium
- **Earned:** Commission paid as premium is collected
- **Chargeback:** If client cancels within lookback period, advance must be returned
- **Key tracking:** `classification` field in production_records

---

## Key Carriers (GHW — 35+)

### Tier 1 (Volume)
UHC/AARP, Aetna, Cigna, Humana, Mutual of Omaha

### Tier 2 (Ancillary)
GTL (Guaranteed Trust Life), Heartland, Medico/Wellabe, ABL (American Benefit Life), Atlantic Coast Life, Assurity, Manhattan Life, Liberty Bankers

### Other Active
Physicians Mutual, BCBS (IL/TN/SC), Aflac, Devoted, CareSource, Allstate, Royal Neighbors, Health Alliance, Bankers

---

## Agent Compliance Requirements

### Licensing
- Must be licensed in the state where the client resides (not where agent is located)
- License renewal: varies by state (typically every 2 years)
- CE (Continuing Education): required for renewal

### Carrier Certifications
- **AHIP:** Annual Medicare certification required by most carriers (typically $175/yr)
- Per-carrier certification: each carrier has annual product training
- **E&O Insurance:** Errors & Omissions required by most FMOs
- **NPN:** National Producer Number — 5-10 digits, validates via NIPR API

### Ready-to-Sell Checklist (per agent × per carrier)
1. State license active in client state
2. AHIP certified for current year
3. Carrier contract signed
4. Carrier product certification complete
5. E&O current
6. Background check cleared (carrier-specific)

---

## GHW Business Context

- **Offices:** Springfield IL + Dickson TN
- **Partner:** Integrity Marketing Group
- **Trusted Partner:** Springfield Clinic
- **Focus:** Medicare Supplement, MAPD, PDP, Annuities, Life, Final Expense, Ancillary
- **Production records:** 6,666+ in MongoDB Atlas (never break these)

---

## Appointment Types (Color Coding in Calendar)
- 🟢 **Autobook** (green) — booked via public booking link, distributed round-robin
- 🟣 **VA** (purple) — set by virtual assistant
- 🟠 **AE** (orange) — Annual Enrollment period specific
- 🔵 **Manual** (blue) — agent self-scheduled

## Appointment Outcomes
- **Showed** — client appeared
- **No Show** — client did not appear → triggers reschedule automation
- **Sold** — policy written → triggers application wizard + commission capture
- **Not Sold** — no policy written
- **Cancelled** — appointment cancelled
- **Rescheduled** — appointment moved to new time

---

## Lead Status Flow
```
new → contacted → qualified → enrolled → lost
```
- `enrolled_at` — write-once, stamped on first transition to enrolled
- `ai_score` — 0-100 urgency score, refreshed nightly by APScheduler

## Lead Sources (tracked)
Webinar, Referral, Direct Mail, Internet, Agent Prospecting, Walk-in, Transfer, Other
