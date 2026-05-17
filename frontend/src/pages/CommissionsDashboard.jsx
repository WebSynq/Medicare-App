import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader, Footer } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}

function statusVariant(status) {
  switch (status) {
    case "digested":
      return "default";
    case "skipped_duplicate":
      return "secondary";
    case "not_recognized":
      return "destructive";
    case "rejected":
      return "destructive";
    case "mock":
    case "unknown":
    default:
      return "outline";
  }
}

function statusLabel(status) {
  switch (status) {
    case "digested":          return "✓ Digested";
    case "skipped_duplicate": return "Duplicate";
    case "not_recognized":    return "⚠ Not Recognized";
    case "rejected":          return "✗ Rejected";
    case "mock":              return "Mock";
    default:                  return status ?? "Unknown";
  }
}

function fmtDate(isoOrSlash) {
  if (!isoOrSlash) return "—";
  try {
    let d;
    if (isoOrSlash.includes("T")) {
      d = new Date(isoOrSlash);
    } else if (isoOrSlash.includes("/")) {
      const [mm, dd, yyyy] = isoOrSlash.split("/");
      d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    } else {
      d = new Date(isoOrSlash + "T00:00:00Z");
    }
    if (isNaN(d.getTime())) return isoOrSlash;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return isoOrSlash;
  }
}

const ACCEPT = ".pdf,.csv,.xlsx,.xls,.txt";

// ── component ─────────────────────────────────────────────────────────────────

export default function CommissionsDashboard() {
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const user = auth.getUser();

  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // ── data fetching ───────────────────────────────────────────────────────────

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const { data } = await api.get("/commissions/summary");
      setSummary(data);
    } catch (err) {
      console.error("Summary fetch error", err);
      toast.error("Could not load commission summary");
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const { data } = await api.get("/commissions/history");
      setHistory(data.uploads || []);
    } catch (err) {
      console.error("History fetch error", err);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    fetchHistory();
  }, [fetchSummary, fetchHistory]);

  // ── upload ──────────────────────────────────────────────────────────────────

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;

      const ext = file.name.split(".").pop().toLowerCase();
      const allowed = ["pdf", "csv", "xlsx", "xls", "txt"];
      if (!allowed.includes(ext)) {
        toast.error("Unsupported file type", {
          description: "Please upload a PDF, CSV, XLSX, or TXT file.",
        });
        return;
      }

      if (file.size > 15 * 1024 * 1024) {
        toast.error("File too large", {
          description: "Maximum file size is 15 MB.",
        });
        return;
      }

      setUploading(true);
      const form = new FormData();
      form.append("file", file);

      try {
        const { data } = await api.post("/commissions/upload", form, {
          headers: { "Content-Type": "multipart/form-data" },
        });

        const messages = {
          digested: "Statement processed successfully.",
          skipped_duplicate: "This statement was already uploaded.",
          not_recognized: "Carrier format not recognized — contact support to add it.",
          rejected: "File could not be read. Re-download from the carrier portal and try again.",
        };

        const msg = messages[data.status] ?? `Status: ${data.status}`;
        if (data.status === "digested") {
          toast.success(msg);
        } else {
          toast.error(msg);
        }

        await Promise.all([fetchSummary(), fetchHistory()]);
      } catch (err) {
        const msg = err?.response?.data?.detail || "Upload failed. Try again.";
        toast.error(msg);
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [fetchSummary, fetchHistory]
  );

  const onFileChange = (e) => handleFile(e.target.files?.[0]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  // ── render ──────────────────────────────────────────────────────────────────

  const statCards = [
    {
      label: "YTD Commissions",
      value: loadingSummary ? "—" : fmt(summary?.ytd_commission ?? 0),
      sub: `${summary?.total_rows ?? 0} total rows`,
    },
    {
      label: "Active Policies",
      value: loadingSummary ? "—" : (summary?.active_policies ?? 0).toString(),
      sub: "No termination date",
    },
    {
      label: "Last Commission",
      value: loadingSummary ? "—" : fmt(summary?.last_paid_amount ?? 0),
      sub: summary?.last_paid_carrier ?? "—",
    },
    {
      label: "Last Statement",
      value: loadingSummary ? "—" : fmtDate(summary?.last_paid_date),
      sub: summary?.mock ? "⚠ Mock data — connect Comtrack" : "Live data",
    },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8 space-y-8">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">Commissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload carrier statements and track your earnings.
              {summary?.mock && (
                <span className="ml-2 text-amber-600 font-medium">
                  (Mock mode — connect Comtrack API key to see live data)
                </span>
              )}
            </p>
          </div>
        </div>

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full overflow-hidden">
          {statCards.map((c) => (
            <Card key={c.label} className="min-w-0 overflow-hidden">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-[#1e2d3d]">{c.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Upload ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#1e2d3d]">
              Upload Commission Statement
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                dragOver
                  ? "border-[#e85d2f] bg-orange-50"
                  : "border-muted-foreground/30 hover:border-[#e85d2f]/60"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={onFileChange}
              />
              {uploading ? (
                <div className="space-y-2">
                  <div className="text-[#e85d2f] font-medium animate-pulse">
                    Uploading…
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sending to Comtrack for parsing
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-[#1e2d3d]">
                    Drop your statement here or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PDF, CSV, XLSX, TXT · Max 15 MB
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 border-[#e85d2f] text-[#e85d2f] hover:bg-orange-50"
                    onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
                  >
                    Choose File
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-4 text-xs text-muted-foreground space-y-1">
              <p>
                <span className="font-medium text-green-700">✓ Digested</span> — parsed and added to your commission records.
              </p>
              <p>
                <span className="font-medium text-amber-600">⚠ Not Recognized</span> — carrier format not yet supported. Contact support.
              </p>
              <p>
                <span className="font-medium text-red-600">✗ Rejected</span> — file unreadable or password-protected. Re-download from carrier portal.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Upload history ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#1e2d3d]">Upload History</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingHistory ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Loading…
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No statements uploaded yet. Upload your first one above.
              </p>
            ) : (
              <div className="overflow-x-auto w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead>Comtrack ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium max-w-[220px] truncate">
                          {row.filename}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(row.status)}>
                            {statusLabel(row.status)}
                          </Badge>
                          {row.mock && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              mock
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {fmtDate(row.uploaded_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono truncate max-w-[160px]">
                          {row.comtrack_file_id || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

      </main>
      <Footer />
    </div>
  );
}
