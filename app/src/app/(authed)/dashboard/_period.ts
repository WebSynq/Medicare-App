/**
 * Shared period type + tab list for the combined dashboard.
 * Lives in its own file so both page.tsx and _agency-section.tsx
 * can import it without circular-dependency contortions.
 */

export type Period = "mtd" | "last30" | "last90" | "ytd";

export const PERIOD_TABS: readonly { value: Period; label: string }[] = [
  { value: "mtd", label: "MTD" },
  { value: "last30", label: "Last 30" },
  { value: "last90", label: "Last 90" },
  { value: "ytd", label: "YTD" },
] as const;
