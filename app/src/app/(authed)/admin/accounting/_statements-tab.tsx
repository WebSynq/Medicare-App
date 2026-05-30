"use client";

/**
 * Statements tab — upload a carrier PDF/CSV statement, then run
 * reconciliation matching against `production_records` and surface
 * the matched/unmatched/underpaid breakdown.
 *
 * `/api/reconciliation/upload` is multipart/form-data — we drop
 * down to fetch for the upload step (axios can do FormData but
 * the dedicated wrapper is small enough to inline). The
 * subsequent `/match` call goes through the typed
 * `accounting.matchStatement` wrapper.
 *
 * Ports `AccountingDashboard.jsx` StatementsTab — upload zone,
 * 5-KPI results row, full reconciliation results table, export
 * CSV + bulk-dispute actions.
 */

import * as React from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accounting } from "@/lib/api";
import type {
  ReconciliationMatchResponse,
  ReconciliationMatchRow,
} from "@/lib/api/accounting";

import { downloadCsv, fmt, fmtShort } from "./_helpers";
import { LedgerStatusBadge } from "./_status-badges";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
const MAX_UPLOAD_MB = 10;

export function StatementsTab() {
  const [carrier, setCarrier] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [statement, setStatement] =
    React.useState<ReconciliationMatchResponse | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  async function handleUpload() {
    if (!file || !carrier) {
      toast.error("Pick a file and carrier first");
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`File exceeds ${MAX_UPLOAD_MB}MB limit`);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("carrier", carrier);
      const resp = await fetch(`${BACKEND_URL}/api/reconciliation/upload`, {
        method: "POST",
        credentials: "include",
        headers: {
          "X-CSRF-Token": readCsrf() ?? "",
        },
        body: fd,
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => "");
        throw new Error(msg || `HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as {
        statement_id: string;
        extracted_count: number;
      };
      toast.success(`Extracted ${json.extracted_count} records — matching…`);
      const matched = await accounting.matchStatement(json.statement_id);
      setStatement(matched);
      toast.success("Reconciliation complete");
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  }

  const summary = statement?.summary;
  const records = statement?.records ?? [];

  function exportCsv() {
    if (records.length === 0) {
      toast.message("Nothing to export.");
      return;
    }
    downloadCsv(`reconciliation_${Date.now()}.csv`, records, [
      { label: "Client", get: (r) => r.client_name ?? "" },
      { label: "Policy #", get: (r) => r.policy_number ?? "" },
      { label: "Product", get: (r) => r.product_type ?? "" },
      { label: "Carrier", get: (r) => r.carrier ?? "" },
      { label: "Expected", get: (r) => r.expected_commission },
      { label: "Received", get: (r) => r.commission_paid ?? "" },
      { label: "Gap", get: (r) => r.gap },
      { label: "Status", get: (r) => r.match_status },
      { label: "Confidence", get: (r) => r.match_confidence },
      { label: "Matched Policy", get: (r) => r.matched_policy_id ?? "" },
    ]);
  }

  async function bulkDisputesForGaps() {
    const gaps = records.filter(
      (r) => r.match_status === "underpaid" && (r.gap ?? 0) > 0,
    );
    if (gaps.length === 0) {
      toast.error("No gaps in this statement");
      return;
    }
    let created = 0;
    for (const r of gaps) {
      try {
        await accounting.createDispute({
          carrier: r.carrier || carrier,
          policy_id: r.matched_policy_id || r.policy_number || null,
          agent_name: r.matched_agent_name || null,
          client_name: r.client_name || null,
          amount_disputed: r.gap,
          reason: "Underpayment identified by reconciliation",
          notes: `Auto-created from statement ${statement?.statement_id}`,
        });
        created += 1;
      } catch {
        // Individual failures swallowed — bulk action surfaces the
        // aggregate count rather than per-row errors.
      }
    }
    toast.success(`Created ${created} dispute${created === 1 ? "" : "s"}`);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Upload carrier statement</CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <Label>Carrier</Label>
              <Input
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="UHC, Aetna, Heartland…"
                data-testid="statement-carrier"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Statement file (PDF or CSV, max {MAX_UPLOAD_MB}MB)</Label>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className="mt-1 rounded-lg border-2 border-dashed border-border bg-secondary/30 p-4 text-center cursor-pointer hover:border-primary/40 transition-colors"
                data-testid="statement-dropzone"
              >
                <Upload className="w-5 h-5 mx-auto text-muted-foreground" />
                <p className="text-xs text-muted-foreground mt-1">
                  {file
                    ? file.name
                    : `Drop file or click to browse · max ${MAX_UPLOAD_MB}MB`}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.csv"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  data-testid="statement-file-input"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleUpload}
              disabled={!file || !carrier || uploading}
              data-testid="upload-statement"
            >
              {uploading ? "Processing…" : "Upload + Reconcile"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {summary ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <SmallKpi
              title="Total Records"
              value={summary.total_records}
              accent="text-foreground"
            />
            <SmallKpi
              title="Matched"
              value={summary.matched}
              accent="text-ghw-forest"
            />
            <SmallKpi
              title="Gaps"
              value={summary.underpaid}
              accent="text-destructive"
            />
            <SmallKpi
              title="Unmatched"
              value={summary.unmatched}
              accent="text-ghw-copper"
            />
            <SmallKpi
              title="Total Gap"
              value={fmtShort(summary.total_gap)}
              accent="text-destructive"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export Reconciliation
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={bulkDisputesForGaps}
              disabled={!summary.underpaid}
              data-testid="bulk-disputes"
            >
              Create Disputes for All Gaps
            </Button>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Reconciliation Results ({records.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {records.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  No reconciled rows.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Policy #</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Expected</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead className="text-right">Gap</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Confidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {records.map((r, i) => (
                        <ResultRow key={i} row={r} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SmallKpi({
  title,
  value,
  accent,
}: {
  title: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {title}
        </div>
        <div
          className={`mt-1 text-xl font-bold tabular-nums font-display ${accent ?? ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function ResultRow({ row }: { row: ReconciliationMatchRow }) {
  return (
    <TableRow>
      <TableCell className="text-xs">{row.client_name ?? "—"}</TableCell>
      <TableCell className="text-xs">{row.policy_number ?? "—"}</TableCell>
      <TableCell className="text-xs">{row.product_type ?? "—"}</TableCell>
      <TableCell className="text-xs text-right tabular-nums">
        {fmt(row.expected_commission)}
      </TableCell>
      <TableCell className="text-xs text-right tabular-nums">
        {fmt(row.commission_paid)}
      </TableCell>
      <TableCell className="text-xs text-right tabular-nums">
        {fmt(row.gap)}
      </TableCell>
      <TableCell>
        <LedgerStatusBadge status={row.match_status} />
      </TableCell>
      <TableCell className="text-xs text-right tabular-nums">
        {row.match_confidence
          ? `${Math.round(row.match_confidence * 100)}%`
          : "—"}
      </TableCell>
    </TableRow>
  );
}

function readCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((r) => r.startsWith("ghw_csrf_token="));
  return match ? decodeURIComponent(match.split("=")[1] ?? "") : null;
}
