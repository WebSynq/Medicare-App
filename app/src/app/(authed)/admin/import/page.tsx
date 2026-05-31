"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  RotateCcw,
  Trash2,
  Trophy,
  UploadCloud,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { adminImport as adminImportApi, isApiError } from "@/lib/api";
import type {
  ImportBatchSummary,
  ImportCommitResponse,
  ImportPreviewResponse,
} from "@/lib/api/admin-import";
import {
  useAuthStore,
  selectIsSuperAdmin,
} from "@/stores/auth";

const ADMIN_ROLES = new Set(["admin", "owner"]);

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

function fmtMoney(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

export default function DataImportPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role ?? null);
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const allowed =
    status === "authed" && (ADMIN_ROLES.has(role ?? "") || isSuperAdmin);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <div className="flex items-center gap-2 mb-1">
          <UploadCloud className="h-4 w-4 text-primary" />
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Admin · Data import
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight font-display">
          Production Data Import
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload the GHW production tracker spreadsheet to seed production
          records.
        </p>
      </header>

      <Tabs defaultValue="new">
        <TabsList>
          <TabsTrigger value="new">New import</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="new" className="mt-4">
          <ImportFlow />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ImportHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── New import wizard ─────────────────────────────────────────────────────

type Step = "upload" | "preview" | "complete";

function ImportFlow() {
  const queryClient = useQueryClient();
  const [step, setStep] = React.useState<Step>("upload");
  const [file, setFile] = React.useState<File | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreviewResponse | null>(
    null,
  );
  const [result, setResult] = React.useState<ImportCommitResponse | null>(
    null,
  );
  const [showErrors, setShowErrors] = React.useState(false);
  const [showMatched, setShowMatched] = React.useState(false);
  const [showUnmatched, setShowUnmatched] = React.useState(true);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const previewMutation = useMutation({
    mutationFn: (f: File) => adminImportApi.preview(f),
    onSuccess: (data) => {
      setPreview(data);
      setStep("preview");
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Preview failed");
      setFile(null);
    },
  });

  const commitMutation = useMutation({
    mutationFn: (batchId: string) => adminImportApi.commit(batchId),
    onSuccess: (data) => {
      setResult(data);
      setStep("complete");
      toast.success(`Imported ${data.records_inserted} record(s)`);
      queryClient.invalidateQueries({ queryKey: ["admin-import", "history"] });
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Commit failed");
    },
  });

  function pickFile(f: File | null | undefined) {
    if (!f) return;
    const ext = "." + (f.name || "").split(".").pop()?.toLowerCase();
    if (![".xlsx", ".xls", ".csv"].includes(ext ?? "")) {
      toast.error("Only .xlsx, .xls, .csv files are accepted.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast.error("File exceeds 10MB limit.");
      return;
    }
    setFile(f);
    setPreview(null);
    previewMutation.mutate(f);
  }

  function resetAll() {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setResult(null);
    setShowErrors(false);
    setShowMatched(false);
    setShowUnmatched(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (step === "upload") {
    return (
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div
            role="button"
            tabIndex={0}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              pickFile(e.dataTransfer?.files?.[0]);
            }}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={cn(
              "rounded-lg border-2 border-dashed transition cursor-pointer text-center p-12",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/60 hover:bg-secondary/30",
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            {previewMutation.isPending ? (
              <div className="space-y-2">
                <UploadCloud className="h-12 w-12 text-primary mx-auto animate-pulse" />
                <div className="text-sm font-medium">Analyzing file…</div>
                <div className="text-xs text-muted-foreground">
                  Parsing rows, validating agents, checking duplicates
                </div>
              </div>
            ) : file ? (
              <div className="flex items-center justify-center gap-3 text-sm">
                <FileText className="h-6 w-6 text-primary" />
                <div className="text-left">
                  <div className="font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtBytes(file.size)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <UploadCloud className="h-12 w-12 text-muted-foreground mx-auto" />
                <div className="text-sm font-medium">
                  Drop the GHW production tracker here
                </div>
                <div className="text-xs text-muted-foreground">
                  .xlsx, .xls, or .csv · max 10MB · auto-previews on upload
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "preview" && preview) {
    const s = preview.summary;
    const matched = preview.agents?.matched ?? [];
    const unmatched = preview.agents?.unmatched ?? [];
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Valid New Records"
            value={fmtNum(s.rows_valid_new)}
            tone="ok"
          />
          <StatCard
            label="Duplicates Skipped"
            value={fmtNum(s.rows_duplicate)}
          />
          <StatCard
            label="Parse Errors"
            value={fmtNum(s.rows_error)}
            tone={s.rows_error > 0 ? "warn" : undefined}
          />
          <StatCard
            label="Agents Found"
            value={fmtNum(matched.length + unmatched.length)}
          />
        </div>

        <Card>
          <CardContent className="p-5 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4" /> Agents
            </h3>

            <button
              type="button"
              onClick={() => setShowMatched((v) => !v)}
              className="w-full text-left flex items-center justify-between p-3 rounded-md bg-ghw-forest/10 border border-ghw-forest/30 hover:bg-ghw-forest/20 transition"
            >
              <span className="text-sm font-medium text-ghw-forest">
                ✓ Matched ({matched.length})
              </span>
              <span className="text-xs text-muted-foreground">
                {showMatched ? "Hide" : "Show"}
              </span>
            </button>
            {showMatched && matched.length > 0 && (
              <ul className="text-xs space-y-1 px-3 pb-1">
                {matched.map((a) => (
                  <li key={a.email} className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {a.name || a.email}
                    </span>{" "}
                    · {a.email}
                  </li>
                ))}
              </ul>
            )}

            {unmatched.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowUnmatched((v) => !v)}
                  className="w-full text-left flex items-center justify-between p-3 rounded-md bg-ghw-copper/10 border border-ghw-copper/30 hover:bg-ghw-copper/20 transition"
                >
                  <span className="text-sm font-medium text-ghw-copper flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Unmatched ({unmatched.length}) — will need to be invited
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {showUnmatched ? "Hide" : "Show"}
                  </span>
                </button>
                {showUnmatched && (
                  <ul className="text-xs space-y-1 px-3 pb-1">
                    {unmatched.map((a) => (
                      <li key={a.email} className="text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {a.name || a.email}
                        </span>{" "}
                        · <span className="font-mono">{a.email}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-3">
            <h3 className="text-sm font-semibold">Product breakdown</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(preview.product_breakdown ?? {}).map(
                ([p, n]) => (
                  <Badge
                    key={p}
                    variant="secondary"
                    className="rounded-full text-xs"
                  >
                    {p}:{" "}
                    <span className="ml-1 font-semibold tabular-nums">{n}</span>
                  </Badge>
                ),
              )}
              {Object.keys(preview.product_breakdown ?? {}).length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No products detected.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {(preview.sample_rows ?? []).length > 0 && (
          <Card>
            <CardContent className="p-5">
              <h3 className="text-sm font-semibold mb-3">
                Sample rows (first {preview.sample_rows.length})
              </h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Carrier</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Premium</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead>App Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.sample_rows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{r.agent}</TableCell>
                        <TableCell className="text-sm">{r.client}</TableCell>
                        <TableCell className="text-sm">{r.carrier}</TableCell>
                        <TableCell className="text-sm">
                          {r.product_type}
                        </TableCell>
                        <TableCell className="text-sm text-right tabular-nums">
                          {fmtMoney(r.premium)}
                        </TableCell>
                        <TableCell className="text-sm text-right tabular-nums">
                          {fmtMoney(r.revenue)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.app_date || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {(preview.errors ?? []).length > 0 && (
          <Card className="border-ghw-copper/40">
            <CardContent className="p-5 space-y-3">
              <button
                type="button"
                onClick={() => setShowErrors((v) => !v)}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-sm font-semibold flex items-center gap-2 text-ghw-copper">
                  <AlertTriangle className="h-4 w-4" />
                  Parse errors (showing first {preview.errors.length})
                </span>
                <span className="text-xs text-muted-foreground">
                  {showErrors ? "Hide" : "Show"}
                </span>
              </button>
              {showErrors && (
                <ul className="space-y-1.5 text-xs">
                  {preview.errors.map((e, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-muted-foreground"
                    >
                      <span className="font-mono text-foreground">
                        row {e.row_num}
                      </span>
                      <span>·</span>
                      <span className="truncate">{e.raw}</span>
                      <span>—</span>
                      <span className="text-ghw-copper">{e.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" onClick={resetAll}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Re-upload
          </Button>
          <ConfirmCommit
            disabled={commitMutation.isPending || s.rows_valid_new === 0}
            pending={commitMutation.isPending}
            count={s.rows_valid_new}
            onConfirm={() => commitMutation.mutate(preview.batch_id)}
          />
        </div>

        <p className="text-[11px] text-muted-foreground text-right">
          Rollback is available from the History tab — but cleanly redo-able
          rather than relied on. Confirm carefully.
        </p>
      </div>
    );
  }

  if (step === "complete" && result) {
    return (
      <Card>
        <CardContent className="pt-10 pb-10 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-ghw-forest/15 grid place-items-center mx-auto">
            <CheckCircle2 className="h-8 w-8 text-ghw-forest" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {fmtNum(result.records_inserted)} record
              {result.records_inserted === 1 ? "" : "s"} imported successfully
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {fmtNum(result.records_skipped)} skipped ·{" "}
              {fmtNum((result.agents_unmatched ?? []).length)} agent(s)
              without a user account
            </p>
          </div>

          {(result.agents_unmatched ?? []).length > 0 && (
            <Card className="border-ghw-copper/40 bg-ghw-copper/10 text-left max-w-md mx-auto">
              <CardContent className="p-4 space-y-2">
                <div className="text-xs font-semibold text-ghw-copper uppercase tracking-wider">
                  Invite these agents
                </div>
                <ul className="text-xs space-y-1">
                  {result.agents_unmatched.map((a) => (
                    <li key={a.email} className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {a.name || a.email}
                      </span>{" "}
                      · <span className="font-mono">{a.email}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Button asChild variant="outline">
              <Link href="/commissions/leaderboard">
                <Trophy className="h-4 w-4 mr-1.5" />
                View Leaderboard
              </Link>
            </Button>
            <Button onClick={resetAll}>Import Another File</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}

function ConfirmCommit({
  disabled,
  pending,
  count,
  onConfirm,
}: {
  disabled: boolean;
  pending: boolean;
  count: number;
  onConfirm: () => void;
}) {
  return (
    <Button onClick={onConfirm} disabled={disabled}>
      <CheckCircle2 className="h-4 w-4 mr-1.5" />
      {pending
        ? "Importing…"
        : `Confirm & Import ${fmtNum(count)} Records`}
    </Button>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <Card
      className={cn(
        tone === "ok" && "border-ghw-forest/30 bg-ghw-forest/5",
        tone === "warn" && "border-ghw-copper/30 bg-ghw-copper/5",
      )}
    >
      <CardContent className="p-4 space-y-1">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

// ─── History tab ────────────────────────────────────────────────────────────

function ImportHistory() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-import", "history"],
    queryFn: adminImportApi.getHistory,
  });

  const [confirmBatch, setConfirmBatch] =
    React.useState<ImportBatchSummary | null>(null);
  const [rollingId, setRollingId] = React.useState<string | null>(null);

  async function doRollback(batchId: string) {
    setRollingId(batchId);
    try {
      const res = await adminImportApi.rollback(batchId);
      toast.success(`Rolled back ${res.records_deleted} record(s)`);
      setConfirmBatch(null);
      queryClient.invalidateQueries({
        queryKey: ["admin-import", "history"],
      });
    } catch (err) {
      toast.error(isApiError(err) ? err.message : "Rollback failed");
    } finally {
      setRollingId(null);
    }
  }

  const batches = query.data?.batches ?? [];

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Past imports
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Imported by</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!query.isLoading && batches.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No imports yet.
                  </TableCell>
                </TableRow>
              )}
              {batches.map((b) => (
                <TableRow key={b.batch_id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtDateTime(b.imported_at)}
                  </TableCell>
                  <TableCell className="text-sm font-medium truncate max-w-[260px]">
                    {b.filename || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {b.imported_by || "—"}
                  </TableCell>
                  <TableCell className="text-sm text-right tabular-nums">
                    {fmtNum(b.records_inserted)}
                  </TableCell>
                  <TableCell>
                    {b.rolled_back ? (
                      <Badge
                        variant="outline"
                        className="bg-destructive/15 text-destructive border-destructive/30"
                      >
                        Rolled back
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                      >
                        Live
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!b.rolled_back && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmBatch(b)}
                        disabled={rollingId === b.batch_id}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Rollback
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <AlertDialog
        open={!!confirmBatch}
        onOpenChange={(open) => {
          if (!open) setConfirmBatch(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Rollback this import?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will hard-delete every record from this batch. The
              action is logged but cannot be undone. The file can be
              re-uploaded afterwards if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmBatch && (
            <div className="rounded-md bg-secondary p-3 text-xs space-y-1">
              <div>
                <span className="text-muted-foreground">File: </span>
                <span className="font-medium">{confirmBatch.filename}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Records: </span>
                <span className="font-medium tabular-nums">
                  {fmtNum(confirmBatch.records_inserted)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Imported: </span>
                <span className="font-medium">
                  {fmtDateTime(confirmBatch.imported_at)}
                </span>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!rollingId}
              onClick={() => setConfirmBatch(null)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!!rollingId}
              onClick={() =>
                confirmBatch && doRollback(confirmBatch.batch_id)
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {rollingId ? "Rolling back…" : "Yes, delete records"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
