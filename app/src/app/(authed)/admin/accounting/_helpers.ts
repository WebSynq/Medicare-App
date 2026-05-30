/**
 * Shared formatters + CSV export helper for the Accounting page.
 * Lives next to the tab files so each tab can grab what it needs
 * without a wider import path.
 */

import type { AccountingPeriod } from "@/lib/api/accounting";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** Full-precision currency string. "—" for null/undefined. */
export function fmt(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return "—";
  return USD.format(val);
}

/** Compact currency string ($1.2k, $4.5M). For headline KPI cards. */
export function fmtShort(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return "—";
  const n = Number(val);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return USD.format(n);
}

/** "Mar 18, 2026" / "—". Accepts ISO date-only or full ISO datetime. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/** "12.5%" / "—". */
export function fmtPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(Number(p))) return "—";
  return `${Number(p).toFixed(1)}%`;
}

/** Plain integer / "—". */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

// ─── Period select ───────────────────────────────────────────────────────
// Backend exposes mtd|ytd|q1|q2|q3|q4|all. The spec mentioned
// "MTD/Last30/Last90/YTD" — last30/last90 don't exist for accounting,
// so the period selector mirrors what /accounting/summary can answer.
export const PERIOD_OPTIONS: readonly {
  value: AccountingPeriod;
  label: string;
}[] = [
  { value: "mtd", label: "MTD" },
  { value: "ytd", label: "YTD" },
  { value: "q1", label: "Q1" },
  { value: "q2", label: "Q2" },
  { value: "q3", label: "Q3" },
  { value: "q4", label: "Q4" },
  { value: "all", label: "All" },
];

// ─── CSV export ──────────────────────────────────────────────────────────

export interface CsvColumn<T> {
  label: string;
  /** Field accessor — return the raw value for the cell. */
  get: (row: T) => string | number | null | undefined;
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV string from rows + columns and trigger a browser
 *  download. Returns silently if rows is empty. */
export function downloadCsv<T>(
  filename: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): void {
  if (rows.length === 0) return;
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows
    .map((r) => columns.map((c) => csvCell(c.get(r))).join(","))
    .join("\n");
  const csv = `${head}\n${body}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
