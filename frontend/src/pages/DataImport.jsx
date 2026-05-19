import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Users,
  Trash2,
  Trophy,
  ArrowLeft,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const STEP = {
  UPLOAD: 0,
  PREVIEW: 1,
  COMPLETE: 2,
};

function fmtNum(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

function fmtMoney(v) {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatCard({ label, value, accent }) {
  return (
    <Card
      className={
        accent === "danger"
          ? "border-red-200 bg-red-50/50"
          : accent === "warn"
            ? "border-amber-200 bg-amber-50/50"
            : accent === "ok"
              ? "border-emerald-200 bg-emerald-50/50"
              : "bg-surface"
      }
    >
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div
          className="text-2xl font-bold mt-1 tabular-nums"
          style={{ fontFamily: "Outfit" }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function ImportFlow() {
  const [step, setStep] = useState(STEP.UPLOAD);
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [showMatched, setShowMatched] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(true);
  const fileInputRef = useRef(null);

  function pickFile(f) {
    if (!f) return;
    const ext = "." + (f.name || "").split(".").pop().toLowerCase();
    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      toast.error("Only .xlsx, .xls, .csv files are accepted.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast.error("File exceeds 10MB limit.");
      return;
    }
    setFile(f);
    autoPreview(f);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer?.files?.[0]);
  }

  async function autoPreview(f) {
    setPreviewing(true);
    setPreview(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const { data } = await api.post("/admin/import/preview", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setPreview(data);
      setStep(STEP.PREVIEW);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Preview failed";
      toast.error(detail);
      setFile(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (!preview?.batch_id) return;
    if (!preview.summary.rows_valid_new) {
      toast.error("Nothing to import.");
      return;
    }
    setCommitting(true);
    try {
      const { data } = await api.post("/admin/import/commit", {
        batch_id: preview.batch_id,
        confirm: true,
      });
      setResult(data);
      setStep(STEP.COMPLETE);
      toast.success(`Imported ${data.records_inserted} record(s)`);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Commit failed";
      toast.error(detail);
    } finally {
      setCommitting(false);
    }
  }

  function resetAll() {
    setStep(STEP.UPLOAD);
    setFile(null);
    setPreview(null);
    setResult(null);
    setShowErrors(false);
    setShowMatched(false);
    setShowUnmatched(true);
  }

  // ── Step 1: Upload ────────────────────────────────────────────────────
  if (step === STEP.UPLOAD) {
    return (
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={[
              "rounded-lg border-2 border-dashed transition cursor-pointer text-center p-12",
              dragOver
                ? "border-[#e85d2f] bg-[#e85d2f]/5"
                : "border-border hover:border-[#e85d2f]/60 hover:bg-secondary/30",
            ].join(" ")}
            data-testid="import-dropzone"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
              data-testid="import-file-input"
            />
            {previewing ? (
              <div className="space-y-2">
                <UploadCloud className="w-12 h-12 text-[#e85d2f] mx-auto animate-pulse" />
                <div className="text-sm font-medium">Analyzing file…</div>
                <div className="text-xs text-muted-foreground">
                  Parsing rows, validating agents, checking duplicates
                </div>
              </div>
            ) : file ? (
              <div className="flex items-center justify-center gap-3 text-sm">
                <FileText className="w-6 h-6 text-[#e85d2f]" />
                <div className="text-left">
                  <div className="font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtBytes(file.size)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <UploadCloud className="w-12 h-12 text-muted-foreground mx-auto" />
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

  // ── Step 2: Preview ───────────────────────────────────────────────────
  if (step === STEP.PREVIEW && preview) {
    const s = preview.summary;
    const matched = preview.agents?.matched || [];
    const unmatched = preview.agents?.unmatched || [];
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Valid New Records"
            value={fmtNum(s.rows_valid_new)}
            accent="ok"
          />
          <StatCard
            label="Duplicates Skipped"
            value={fmtNum(s.rows_duplicate)}
          />
          <StatCard
            label="Parse Errors"
            value={fmtNum(s.rows_error)}
            accent={s.rows_error > 0 ? "warn" : null}
          />
          <StatCard
            label="Agents Found"
            value={fmtNum(matched.length + unmatched.length)}
          />
        </div>

        <Card>
          <CardContent className="p-5 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4" /> Agents
            </h3>

            <button
              type="button"
              onClick={() => setShowMatched((v) => !v)}
              className="w-full text-left flex items-center justify-between p-3 rounded-md bg-emerald-50 border border-emerald-200 hover:bg-emerald-100/60 transition"
              data-testid="matched-toggle"
            >
              <span className="text-sm font-medium text-emerald-900">
                ✅ Matched ({matched.length})
              </span>
              <span className="text-xs text-emerald-700">
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
                  className="w-full text-left flex items-center justify-between p-3 rounded-md bg-amber-50 border border-amber-200 hover:bg-amber-100/60 transition"
                  data-testid="unmatched-toggle"
                >
                  <span className="text-sm font-medium text-amber-900 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Unmatched ({unmatched.length}) — will need to be invited
                  </span>
                  <span className="text-xs text-amber-700">
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
              {Object.entries(preview.product_breakdown || {}).map(([p, n]) => (
                <Badge
                  key={p}
                  variant="secondary"
                  className="rounded-full text-xs"
                >
                  {p}: <span className="ml-1 font-semibold tabular-nums">{n}</span>
                </Badge>
              ))}
              {Object.keys(preview.product_breakdown || {}).length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No products detected.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {preview.sample_rows?.length > 0 && (
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

        {preview.errors?.length > 0 && (
          <Card className="border-amber-200">
            <CardContent className="p-5 space-y-3">
              <button
                type="button"
                onClick={() => setShowErrors((v) => !v)}
                className="w-full flex items-center justify-between text-left"
                data-testid="errors-toggle"
              >
                <span className="text-sm font-semibold flex items-center gap-2 text-amber-900">
                  <AlertTriangle className="w-4 h-4" />
                  Parse errors (showing first {preview.errors.length})
                </span>
                <span className="text-xs text-amber-700">
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
                      <span className="text-amber-700">{e.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            onClick={resetAll}
            data-testid="reupload-btn"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Re-upload
          </Button>
          <Button
            onClick={handleCommit}
            disabled={committing || s.rows_valid_new === 0}
            data-testid="confirm-import-btn"
          >
            <CheckCircle2 className="w-4 h-4 mr-1.5" />
            {committing
              ? "Importing…"
              : `Confirm & Import ${fmtNum(s.rows_valid_new)} Records`}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground text-right">
          Rollback is available from the History tab — but cleanly redo-able
          rather than relied on. Confirm carefully.
        </p>
      </div>
    );
  }

  // ── Step 3: Complete ──────────────────────────────────────────────────
  if (step === STEP.COMPLETE && result) {
    return (
      <Card>
        <CardContent className="pt-10 pb-10 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-emerald-100 grid place-items-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {fmtNum(result.records_inserted)} record
              {result.records_inserted === 1 ? "" : "s"} imported successfully
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {fmtNum(result.records_skipped)} skipped ·{" "}
              {fmtNum((result.agents_unmatched || []).length)} agent(s) without
              a user account
            </p>
          </div>

          {result.agents_unmatched?.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/40 text-left max-w-md mx-auto">
              <CardContent className="p-4 space-y-2">
                <div className="text-xs font-semibold text-amber-900 uppercase tracking-wider">
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
              <Link to="/leaderboard">
                <Trophy className="w-4 h-4 mr-1.5" />
                View Leaderboard
              </Link>
            </Button>
            <Button onClick={resetAll} data-testid="import-another-btn">
              Import Another File
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}

function ImportHistory() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rolling, setRolling] = useState(null);
  const [confirmBatch, setConfirmBatch] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/import/history");
      setBatches(data.batches || []);
    } catch (err) {
      toast.error("Failed to load import history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function rollback(batchId) {
    setRolling(batchId);
    try {
      const { data } = await api.delete(`/admin/import/${batchId}`);
      toast.success(`Rolled back ${data.records_deleted} record(s)`);
      setConfirmBatch(null);
      load();
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Rollback failed"
      );
    } finally {
      setRolling(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Past imports
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            data-testid="history-refresh"
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
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && batches.length === 0 && (
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
                <TableRow
                  key={b.batch_id}
                  data-testid={`history-row-${b.batch_id}`}
                >
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
                      <Badge className="rounded-full bg-red-100 text-red-900 border-0">
                        Rolled back
                      </Badge>
                    ) : (
                      <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
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
                        disabled={rolling === b.batch_id}
                        data-testid={`rollback-btn-${b.batch_id}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
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

      {/* Confirm rollback modal */}
      {confirmBatch && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmBatch(null);
          }}
          data-testid="rollback-confirm-modal"
        >
          <div className="w-full max-w-md rounded-xl p-6 bg-white shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <Trash2 className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-[#1e2d3d]">
                Rollback this import?
              </h2>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              This will hard-delete every record from this batch. The action
              is logged but cannot be undone. The file can be re-uploaded
              afterwards if needed.
            </p>
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
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="outline"
                onClick={() => setConfirmBatch(null)}
                disabled={rolling === confirmBatch.batch_id}
              >
                Cancel
              </Button>
              <Button
                onClick={() => rollback(confirmBatch.batch_id)}
                disabled={rolling === confirmBatch.batch_id}
                className="bg-red-600 hover:bg-red-700 text-white"
                data-testid="rollback-confirm-btn"
              >
                {rolling === confirmBatch.batch_id
                  ? "Rolling back…"
                  : "Yes, delete records"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function DataImport() {
  return (
    <div className="p-6 md:p-8">
      <main className="max-w-5xl mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <UploadCloud className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Admin · Data import
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Production Data Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload the GHW Plecto tracker spreadsheet to seed production
            records.
          </p>
        </div>

        <Tabs defaultValue="new" className="w-full">
          <TabsList>
            <TabsTrigger value="new" data-testid="tab-new-import">
              New import
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="new" className="mt-4">
            <ImportFlow />
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <ImportHistory />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
