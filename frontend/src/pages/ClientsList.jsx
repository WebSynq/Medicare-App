import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  Filter,
  Users2,
  Sparkles,
  FileSignature,
  ShieldCheck,
  ArrowUpRight,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import QuickAddLeadSheet from "@/components/QuickAddLeadSheet";

const PAGE_SIZE = 20;

// Spec labels → backend status values. "Inactive" in the UI maps to the
// existing "lost" status in the data model; "qualified" is an internal stage
// we keep available so admins can still see it via "All".
const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "enrolled", label: "Enrolled" },
  { value: "lost", label: "Inactive" },
];

const STATUS_BADGE = {
  new: "bg-blue-100 text-blue-900",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-50 text-emerald-900",
  enrolled: "bg-emerald-100 text-emerald-900",
  lost: "bg-gray-200 text-gray-700",
};

const SYNC_DOT = {
  pending: "bg-amber-500",
  synced: "bg-emerald-500",
  mock: "bg-blue-500",
  error: "bg-destructive",
};

function StatCard({ label, value, icon: Icon }) {
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className="text-3xl font-bold mt-2 tabular-nums"
          style={{ fontFamily: "Outfit" }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function isThisMonth(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth()
  );
}

export default function ClientsList() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("all");
  const [product, setProduct] = useState("all");
  const [page, setPage] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Debounce search box (server query)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (status !== "all") params.status = status;
      if (debouncedQ.trim()) params.q = debouncedQ.trim();
      const res = await api.get("/leads", { params });
      setLeads(res.data || []);
      setPage(1);
    } catch (e) {
      toast.error("Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // load reads `status` and `debouncedQ` from closure, so depending on those
    // is sufficient. eslint just can't tell because load is defined inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, debouncedQ]);

  // Available product options derived from the loaded set (omit filter when empty)
  const productOptions = useMemo(() => {
    const set = new Set();
    leads.forEach((l) => {
      if (l.plan_type_premium) set.add(l.plan_type_premium);
    });
    return Array.from(set).sort();
  }, [leads]);

  const filtered = useMemo(() => {
    if (product === "all") return leads;
    return leads.filter((l) => l.plan_type_premium === product);
  }, [leads, product]);

  const stats = useMemo(() => {
    const total = leads.length;
    const newThisMonth = leads.filter((l) => isThisMonth(l.created_at)).length;
    const soa = leads.filter((l) => l.soa_signed).length;
    const synced = leads.filter(
      (l) => l.ghl_sync_status === "synced" || l.ghl_sync_status === "mock"
    ).length;
    return { total, newThisMonth, soa, synced };
  }, [leads]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Clamp page when filters shrink the result set
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Users2 className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                CRM
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Clients
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              All Medicare clients and leads
            </p>
            <ImpersonationBanner />
          </div>
          <Button onClick={() => setSheetOpen(true)} data-testid="new-client-btn">
            <Plus className="w-4 h-4 mr-1.5" />
            New Client
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total Clients" value={stats.total} icon={Users2} />
          <StatCard
            label="New This Month"
            value={stats.newThisMonth}
            icon={Sparkles}
          />
          <StatCard label="SOA Signed" value={stats.soa} icon={FileSignature} />
          <StatCard
            label="Synced to GHL"
            value={stats.synced}
            icon={ShieldCheck}
          />
        </div>

        <Card className="bg-surface">
          <CardContent className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, phone..."
                  className="pl-9 h-10"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  data-testid="clients-search"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger
                  className="w-40 h-10"
                  data-testid="clients-status-filter"
                >
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {productOptions.length > 0 && (
                <Select value={product} onValueChange={setProduct}>
                  <SelectTrigger
                    className="w-52 h-10"
                    data-testid="clients-product-filter"
                  >
                    <SelectValue placeholder="All products" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All products</SelectItem>
                    {productOptions.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="overflow-x-auto w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Contact Info</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SOA</TableHead>
                    <TableHead>GHL</TableHead>
                    <TableHead>Products</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center py-10 text-muted-foreground"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading && pageRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center py-10 text-muted-foreground"
                      >
                        No clients match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {pageRows.map((l) => (
                    <TableRow
                      key={l.id}
                      className="hover:bg-secondary/40"
                      data-testid={`client-row-${l.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          to={`/clients/${l.id}`}
                          className="hover:text-[#e85d2f]"
                        >
                          {l.first_name} {l.last_name}
                        </Link>
                        {l.mbi_number && (
                          <div className="text-xs text-muted-foreground font-mono">
                            MBI ••••{l.mbi_number.slice(-4)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{l.phone || "—"}</div>
                        <div className="text-muted-foreground text-xs">
                          {l.email || ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`rounded-full capitalize ${
                            STATUS_BADGE[l.status] || "bg-secondary"
                          }`}
                        >
                          {l.status === "lost" ? "inactive" : l.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {l.soa_signed ? (
                          <span className="text-xs flex items-center gap-1.5 text-emerald-700">
                            <FileSignature className="w-3.5 h-3.5" />
                            Signed
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Pending
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              SYNC_DOT[l.ghl_sync_status] || "bg-muted"
                            }`}
                          />
                          <span className="capitalize">{l.ghl_sync_status}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.plan_type_premium || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(l.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          to={`/clients/${l.id}`}
                          data-testid={`client-view-${l.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-[#e85d2f] hover:underline"
                        >
                          View
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-between pt-2 text-sm">
                <div className="text-muted-foreground">
                  Showing {(page - 1) * PAGE_SIZE + 1}–
                  {Math.min(page * PAGE_SIZE, filtered.length)} of{" "}
                  {filtered.length}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    data-testid="clients-prev"
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page} of {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page >= pageCount}
                    data-testid="clients-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <QuickAddLeadSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={() => load()}
      />
    </div>
  );
}
