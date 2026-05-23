import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Papa from "papaparse";
import {
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  X as XIcon,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

// Single source of truth for the template + the preview's column
// ordering. Backend will accept any subset of these (case-insensitive)
// — the template encodes the canonical shape so first-time uploaders
// don't need to reverse-engineer the schema.
const TEMPLATE_COLUMNS = [
  "full_name",
  "phone",
  "email",
  "state",
  "date_of_birth",
  "carrier",
  "product_type",
  "lead_source",
];

const TEMPLATE_ROWS = [
  [
    "Jane Smith",
    "555-123-4567",
    "jane@example.com",
    "IL",
    "1955-03-15",
    "Aetna",
    "Med Supp",
    "Referral",
  ],
  [
    "Robert Johnson",
    "555-987-6543",
    "robert@example.com",
    "FL",
    "03/22/1958",
    "Humana",
    "MAPD",
    "Web",
  ],
];

const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 5;

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadTemplate() {
  // Client-side CSV build — no backend dependency. Wrap each cell in
  // double quotes only when it contains a comma; the example rows are
  // chosen to avoid that, so the simple join below is safe.
  const lines = [
    TEMPLATE_COLUMNS.join(","),
    ...TEMPLATE_ROWS.map((r) => r.join(",")),
  ];
  const blob = new Blob([lines.join("\n") + "\n"], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ghw-leads-template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ImportLeads() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewError, setPreviewError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  const reset = () => {
    setFile(null);
    setPreviewHeaders([]);
    setPreviewRows([]);
    setPreviewError(null);
    setResult(null);
    setShowErrors(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFile = useCallback((picked) => {
    if (!picked) return;
    if (!/\.csv$/i.test(picked.name)) {
      toast.error("Only .csv files are accepted");
      return;
    }
    if (picked.size > MAX_BYTES) {
      toast.error(`File too large — 5 MB max, got ${fmtBytes(picked.size)}`);
      return;
    }
    setFile(picked);
    setResult(null);
    setPreviewError(null);

    // Client-side preview via PapaParse — only the first 5 data rows
    // so a large file doesn't lock the tab.
    Papa.parse(picked, {
      header: true,
      preview: PREVIEW_ROWS,
      skipEmptyLines: "greedy",
      complete: (out) => {
        if (out.errors && out.errors.length > 0) {
          setPreviewError(out.errors[0].message || "Could not parse CSV.");
        }
        setPreviewHeaders(out.meta?.fields || []);
        setPreviewRows(out.data || []);
      },
      error: (err) => {
        setPreviewError(err?.message || "Could not parse CSV.");
        setPreviewHeaders([]);
        setPreviewRows([]);
      },
    });
  }, []);

  function onDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const picked = e.dataTransfer?.files?.[0];
    if (picked) handleFile(picked);
  }

  async function submit() {
    if (!file || submitting) return;
    setSubmitting(true);
    setShowErrors(false);
    try {
      const fd = new FormData();
      fd.append("csv_file", file);
      const res = await api.post("/leads/import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(res.data);
      const { imported } = res.data || {};
      toast.success(
        imported === 1
          ? "1 lead imported"
          : `${imported || 0} leads imported`,
      );
    } catch (err) {
      const detail = err?.response?.data?.detail;
      toast.error(
        Array.isArray(detail)
          ? detail[0]?.msg || "Import failed"
          : detail || "Import failed",
      );
      setResult(null);
    } finally {
      setSubmitting(false);
    }
  }

  const previewKeys = useMemo(
    () => (previewHeaders.length ? previewHeaders : []),
    [previewHeaders],
  );

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1200px] mx-auto w-full">
        <Link
          to="/clients"
          className="text-sm text-muted-foreground inline-flex items-center hover:text-[#e85d2f] mb-3"
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
        </Link>

        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Upload className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Bulk Operations
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Import Leads
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload a CSV to add leads in bulk. Existing emails are
              skipped automatically.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={downloadTemplate}
            data-testid="import-download-template"
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Download Template
          </Button>
        </div>

        <Card className="bg-surface mb-4">
          <CardContent className="p-6">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
                isDragging
                  ? "border-[#e85d2f] bg-[#e85d2f]/5"
                  : "border-border hover:border-[#e85d2f]/40 hover:bg-secondary/30"
              }`}
              data-testid="import-drop-zone"
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
                data-testid="import-file-input"
              />
              {file ? (
                <div className="space-y-2">
                  <FileSpreadsheet className="w-8 h-8 text-[#e85d2f] mx-auto" />
                  <div className="text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtBytes(file.size)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      reset();
                    }}
                  >
                    <XIcon className="w-3.5 h-3.5 mr-1.5" />
                    Choose a different file
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <Upload className="w-8 h-8 text-muted-foreground mx-auto" />
                  <div className="text-sm font-medium">
                    Drop a CSV here or click to browse
                  </div>
                  <div className="text-xs text-muted-foreground">
                    5 MB max · UTF-8 · headers required
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {previewError && (
          <Card className="bg-rose-50 border-rose-200 mb-4">
            <CardContent className="p-4 text-sm text-rose-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{previewError}</span>
            </CardContent>
          </Card>
        )}

        {previewKeys.length > 0 && !previewError && (
          <Card className="bg-surface mb-4">
            <CardContent className="p-0">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">Preview (first {PREVIEW_ROWS} rows)</h3>
                <span className="text-[11px] text-muted-foreground">
                  Confirm the columns map to what you expected before
                  importing.
                </span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {previewKeys.map((k) => (
                        <TableHead key={k} className="text-[11px] uppercase">
                          {k}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row, i) => (
                      <TableRow key={i}>
                        {previewKeys.map((k) => (
                          <TableCell key={k} className="text-xs">
                            {row[k] || (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-end gap-2 mb-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/clients")}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!file || submitting || !!previewError}
            className="bg-[#e85d2f] hover:bg-[#c84416]"
            data-testid="import-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Importing…
              </>
            ) : (
              <>
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Import
              </>
            )}
          </Button>
        </div>

        {result && (
          <Card className="bg-surface" data-testid="import-results">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <h3 className="text-sm font-semibold">Import complete</h3>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ResultStat label="Imported" value={result.imported} />
                <ResultStat
                  label="Skipped (duplicates)"
                  value={result.skipped_duplicates}
                />
                <ResultStat
                  label="Skipped (empty)"
                  value={result.skipped_empty}
                />
                <ResultStat
                  label="Errors"
                  value={result.errors?.length || 0}
                  tone={result.errors?.length ? "warn" : "ok"}
                />
              </div>
              <div className="text-[11px] text-muted-foreground">
                {result.total_rows} total rows processed.
              </div>
              {result.errors?.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <button
                    type="button"
                    className="text-xs text-rose-700 hover:underline"
                    onClick={() => setShowErrors((s) => !s)}
                  >
                    {showErrors ? "Hide" : "Show"} {result.errors.length} error
                    {result.errors.length === 1 ? "" : "s"}
                  </button>
                  {showErrors && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {result.errors.map((e, i) => (
                        <li key={i} className="text-rose-900">
                          Row {e.row}: {e.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => navigate("/clients")}
                >
                  Back to Clients
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

function ResultStat({ label, value, tone }) {
  const color =
    tone === "warn"
      ? "text-rose-700"
      : tone === "ok"
        ? "text-emerald-700"
        : "text-foreground";
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-2xl font-bold tabular-nums mt-1 ${color}`}
        style={{ fontFamily: "Outfit" }}
      >
        {value ?? 0}
      </div>
    </div>
  );
}
