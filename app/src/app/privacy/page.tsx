import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Gruening Health & Wealth",
  description:
    "HIPAA Notice of Privacy Practices and Privacy Policy for Gruening Health & Wealth.",
};

const SECTIONS: { title: string; content: string }[] = [
  {
    title: "1. Who We Are",
    content: `Gruening Health & Wealth (GHW) is a Medicare and retirement planning insurance agency with offices in Springfield, IL and Dickson, TN. We are licensed insurance agents and brokers who assist Medicare beneficiaries in selecting and enrolling in Medicare Supplement, Medicare Advantage, Prescription Drug Plans, and other related insurance products.

As an insurance agency handling Medicare information, GHW is a covered entity under the Health Insurance Portability and Accountability Act (HIPAA) and is subject to its requirements regarding the protection of your health information.`,
  },
  {
    title: "2. Information We Collect",
    content: `When you work with a GHW agent, we may collect the following types of information:

• Personal Identification: Full name, date of birth, address, phone number, email address
• Medicare Information: Medicare Beneficiary Identifier (MBI), Medicare Part A and Part B effective dates
• Health Information: Current health insurance carrier and plan, primary care physicians, current medications
• Financial Information: Bank routing and account numbers (for premium payment setup, when applicable)
• Enrollment Information: Plan preferences, coverage needs, scope of appointment documentation

This information is collected directly from you during the intake and enrollment process.`,
  },
  {
    title: "3. How We Use Your Information",
    content: `GHW uses your information for the following purposes:

• Insurance Services: To help you compare, select, and enroll in Medicare insurance plans
• Treatment, Payment, and Operations: As permitted under HIPAA for healthcare operations
• Scope of Appointment: To document your consent to discuss specific Medicare plan types
• Compliance: To meet our obligations under Medicare marketing and compliance requirements
• Communication: To follow up with you regarding your coverage and enrollment

We do not sell your personal information to third parties for marketing purposes.`,
  },
  {
    title: "4. How We Protect Your Information",
    content: `GHW takes the security of your information seriously. We use the following protections:

• Encryption: All documents you upload (Medicare card, ID, financial documents) are encrypted using AES-256 encryption before storage
• Secure Transmission: All data is transmitted over HTTPS/TLS encrypted connections
• Access Controls: Only your assigned agent and authorized GHW administrators can access your information
• Audit Trail: All access to your records is logged with timestamps and IP addresses
• Limited Sharing: Your Protected Health Information (PHI) is never shared with our CRM system (GoHighLevel) — only non-sensitive contact information is synchronized
• Signed BAA: We maintain Business Associate Agreements with all vendors who may access your information`,
  },
  {
    title: "5. Scope of Appointment (SOA)",
    content: `Before discussing Medicare plan options with you, federal law requires us to document a Scope of Appointment. This document records:

• The plan types you agreed to discuss
• The date and time of your agreement
• Your electronic signature
• Your IP address (for verification)

Scope of Appointment records are retained for a minimum of 10 years as required by the Centers for Medicare & Medicaid Services (CMS).`,
  },
  {
    title: "6. Sharing Your Information",
    content: `We may share your information in the following limited circumstances:

• With insurance carriers: To obtain quotes or submit enrollment applications on your behalf, with your authorization
• With our upline/NMO: Integrity Marketing Group, as required for licensing and compliance
• As required by law: In response to a valid legal process, court order, or regulatory requirement
• With Business Associates: Vendors under signed Business Associate Agreements who assist in delivering our services

We do not share your information with any other third parties without your explicit consent.`,
  },
  {
    title: "7. Your Rights",
    content: `You have the following rights regarding your health information:

• Right to Access: You may request a copy of the health information we hold about you
• Right to Correct: You may request corrections to inaccurate information
• Right to Know: You may request an accounting of disclosures we have made of your information
• Right to Restrict: You may request restrictions on certain uses and disclosures
• Right to Complain: You have the right to file a complaint with GHW or with the U.S. Department of Health and Human Services if you believe your privacy rights have been violated

To exercise any of these rights, contact our Privacy Officer at the information below.`,
  },
  {
    title: "8. Data Retention",
    content: `GHW retains your information for the following periods:

• Scope of Appointment records: Minimum 10 years (CMS requirement)
• Medicare intake and enrollment records: 7 years minimum
• Audit logs: Retained indefinitely for compliance purposes
• Documents: Retained for the duration of your relationship with GHW and for the applicable legal retention period thereafter`,
  },
  {
    title: "9. Contact Us",
    content: `Privacy Officer / HIPAA Security Officer:
Matt Monacelli, Director
Gruening Health & Wealth
Springfield, IL / Dickson, TN

For privacy questions or to exercise your rights, contact Matt Monacelli through your assigned GHW agent or by reaching out to the agency directly.

To file a complaint with HHS: hhs.gov/hipaa/filing-a-complaint

We will not retaliate against you for filing a complaint.`,
  },
  {
    title: "10. Changes to This Notice",
    content: `GHW reserves the right to change this Privacy Policy and Notice of Privacy Practices at any time. Changes will be effective upon posting to this page. We will update the "Last Updated" date at the top of this notice. If we make material changes, we will notify agents through the platform.`,
  },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#f8f9fa]">
      <header className="bg-[#1e2d3d] border-b-[3px] border-[#e85d2f]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[#e85d2f]">
              <span className="text-white font-bold text-sm">G</span>
            </div>
            <span className="text-white font-semibold text-sm">
              Gruening Health & Wealth
            </span>
          </div>
          <Link
            href="/login"
            className="text-sm text-white/60 hover:text-white"
          >
            Agent Login →
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-2 text-[#1e2d3d] tracking-tight">
            Privacy Policy & Notice of Privacy Practices
          </h1>
          <p className="text-sm text-[#666]">
            Effective Date: May 2026 · Last Updated: May 2026
          </p>
        </div>

        <div className="rounded-lg p-4 mb-8 border-l-4 bg-[#fff8f0] border-[#e85d2f]">
          <p className="text-sm font-semibold mb-1 text-[#1e2d3d]">
            HIPAA Notice of Privacy Practices
          </p>
          <p className="text-sm text-[#555]">
            This notice describes how medical information about you may be used
            and disclosed and how you can get access to this information. Please
            review it carefully. Gruening Health & Wealth is required by law to
            maintain the privacy of your protected health information and to
            provide you with this notice of our legal duties and privacy
            practices.
          </p>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.title} className="mb-8">
            <h2 className="text-lg font-semibold mb-3 text-[#1e2d3d]">
              {section.title}
            </h2>
            {section.content.split("\n\n").map((para, j) => (
              <p key={j} className="text-sm leading-relaxed mb-3 text-[#444]">
                {para.split("\n").map((line, k, arr) => (
                  <span key={k}>
                    {line}
                    {k < arr.length - 1 && <br />}
                  </span>
                ))}
              </p>
            ))}
          </section>
        ))}

        <footer className="mt-12 pt-6 border-t border-[#e0e0e0] text-xs text-[#999]">
          <p>© 2026 Gruening Health & Wealth. All rights reserved.</p>
          <p className="mt-1">
            <Link href="/security" className="hover:underline text-[#e85d2f]">
              Security Practices
            </Link>
            {" · "}
            <Link href="/login" className="hover:underline text-[#e85d2f]">
              Agent Login
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}
