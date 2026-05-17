import { useState, useEffect, useCallback } from "react";
import { AppHeader, Footer } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return iso; }
}

function statusConfig(s) {
  switch (s) {
    case "current":
      return { label: "Current", variant: "default", dot: "bg-green-500" };
    case "stale":
      return { label: "Stale", variant: "secondary", dot: "bg-amber-500" };
    case "no_data":
    default:
      return { label: "No Data", variant: "outline", dot: "bg-gray-300" };
  }
}

function accountStatusConfig(s) {
  switch (s) {
    case "active":   return { label: "Active",   variant: "default" };
    case "pending":  return { label: "Pending",  variant: "secondary" };
    case "rejected": return { label: "Rejected", variant: "destructive" };
    default:         return { label: s, variant: "outline" };
  }
}

const SORT_KEYS = {
  full_name:      (a, b) => a.full_name.localeCompare(b.full_name),
  agency_name:    (a, b) => a.agency_name.localeCompare(b.agency_name),
  total_uploads:  (a, b) => a.total_uploads - b.total_uploads,
  last_upload:    (a, b) => (a.last_upload || "").localeCompare(b.last_upload || ""),
  commission_status: (a, b) => {
    const order = { current: 0, stale: 1, no_data: 2 };
    return (order[a.commission_status] ?? 3) - (order[b.commission_status] ?? 3);
  },
};

function exportCSV(agents) {
  const headers = [
    "Name", "Email", "Agency", "Account Status",
    "Total Uploads", "Digested", "Not Recognized", "Rejected",
    "Last Upload", "Commission Status",
  ];
  const rows = agents.map((a) => [
    a.full_name,
    a.email,
    a.agency_name,
    a.account_status,
    a.total_uploads,
    a.digested_count,
    a.not_recognized_count,
    a.rejected_count,
    a.last_upload ? new Date(a.last_upload).toLocaleDateString() : "",
    a.commission_status,
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `agent-commissions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── component ─────────────────────────────────────────────────────────────────

export default function AdminCommissions() {
  const user = auth.getUser();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("commission_status");
  const [sortDir, setSortDir] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: res } = await api.get("/admin/commissions");
      setData(res);
    } catch (err) {
      toast.error("Could not load agent commission data.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const agents = data?.agents ?? [];

  const filtered = agents
    .filter((a) => {
      if (statusFilter !== "all" && a.commission_status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          a.full_name.toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q) ||
          a.agency_name.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => (SORT_KEYS[sortKey]?.(a, b) ?? 0) * sortDir);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => d * -1);
    else { setSortKey(key); setSortDir(1); }
  };

  const SortHeader = ({ colKey, children }) => (
    <TableHead
      className="cursor-pointer select-none hover:text-[#1e2d3d]"
      onClick={() => toggleSort(colKey)}
    >
      {children}
      {sortKey === colKey ? (sortDir === 1 ? " ↑" : " ↓") : " ↕"}
    </TableHead>
  );

  const summary = data?.summary ?? {};

  const cards = [
    {
      label: "Total Agents",
      value: loading ? "—" : summary.total_agents ?? 0,
      sub: "Registered in system",
      onClick: () => setStatusFilter("all"),
      active: statusFilter === "all",
    },
    {
      label: "Current",
      value: loading ? "—" : summary.current ?? 0,
      sub: "Uploaded within 30 days",
      dot: "bg-green-500",
      onClick: () => setStatusFilter(statusFilter === "current" ? "all" : "current"),
      active: statusFilter === "current",
    },
    {
      label: "Stale",
      value: loading ? "—" : summary.stale ?? 0,
      sub: "No upload in 30+ days",
      dot: "bg-amber-500",
      onClick: () => setStatusFilter(statusFilter === "stale" ? "all" : "stale"),
      active: statusFilter === "stale",
    },
    {
      label: "No Data",
      value: loading ? "—" : summary.no_data ?? 0,
      sub: "Never uploaded — follow up",
      dot: "bg-gray-300",
      onClick: () => setStatusFilter(statusFilter === "no_data" ? "all" : "no_data"),
      active: statusFilter === "no_data",
    },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader user={user} />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8 space-y-8">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">Agent Commissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Full roster — upload activity and commission status for all agents.
              <span className="ml-2 text-amber-600 font-medium">
                YTD figures available after Comtrack API key is connected.
              </span>
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-[#1e2d3d] text-[#1e2d3d] hover:bg-[#1e2d3d] hover:text-white"
            onClick={() => exportCSV(filtered)}
            disabled={loading || filtered.length === 0}
          >
            Export CSV
          </Button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <Card
              key={c.label}
              className={`cursor-pointer transition-all ${
                c.active ? "ring-2 ring-[#e85d2f]" : "hover:shadow-md"
              }`}
              onClick={c.onClick}
            >
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  {c.dot && <span className={`w-2 h-2 rounded-full ${c.dot}`} />}
                  {c.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-[#1e2d3d]">{c.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-base text-[#1e2d3d]">
                {statusFilter === "all"
                  ? `All Agents (${filtered.length})`
                  : `${statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1).replace("_", " ")} (${filtered.length})`}
              </CardTitle>
              <Input
                placeholder="Search name, email, agency…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs h-8 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-8 text-center animate-pulse">
                Loading agent roster…
              </p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No agents match your filter.
              </p>
            ) : (
              <div className="overflow-x-auto w-full -mx-4 px-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortHeader colKey="full_name">Agent</SortHeader>
                      <TableHead>Email</TableHead>
                      <SortHeader colKey="agency_name">Agency</SortHeader>
                      <TableHead className="text-right">YTD</TableHead>
                      <SortHeader colKey="total_uploads">
                        <span className="block text-right">Uploads</span>
                      </SortHeader>
                      <SortHeader colKey="last_upload">Last Upload</SortHeader>
                      <SortHeader colKey="commission_status">Status</SortHeader>
                      <TableHead>Account</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((agent) => {
                      const sc = statusConfig(agent.commission_status);
                      const ac = accountStatusConfig(agent.account_status);
                      return (
                        <TableRow key={agent.id}>
                          <TableCell className="font-medium text-[#1e2d3d]">
                            {agent.full_name || "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {agent.email}
                          </TableCell>
                          <TableCell className="text-sm">
                            {agent.agency_name || "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {agent.ytd_commission != null
                              ? new Intl.NumberFormat("en-US", {
                                  style: "currency", currency: "USD",
                                }).format(agent.ytd_commission)
                              : <span className="text-xs italic">Pending</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="font-medium">{agent.total_uploads}</span>
                            {agent.total_uploads > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">
                                ({agent.digested_count}✓
                                {agent.not_recognized_count > 0 && ` ${agent.not_recognized_count}⚠`}
                                {agent.rejected_count > 0 && ` ${agent.rejected_count}✗`})
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {fmtDate(agent.last_upload)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sc.dot}`} />
                              <Badge variant={sc.variant}>{sc.label}</Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={ac.variant}>{ac.label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
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
