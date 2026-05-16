import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ArrowUpRight, Filter, ShieldCheck, AlertCircle, FileSignature } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, auth } from "@/lib/api";
import { AppHeader, Footer } from "@/components/Layout";

const STATUS_COLORS = {
  new: "bg-secondary text-secondary-foreground",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-100 text-emerald-900",
  enrolled: "bg-primary text-primary-foreground",
  lost: "bg-muted text-muted-foreground",
};

const SYNC_DOT = {
  pending: "bg-amber-500",
  synced: "bg-emerald-500",
  mock: "bg-blue-500",
  error: "bg-destructive",
};

export default function AgentDashboard() {
  const [leads, setLeads] = useState([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const user = auth.getUser();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);
  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/leads", { params: { status: status === "all" ? undefined : status, q: q || undefined } });
      setLeads(res.data);
    } finally { setLoading(false); }
  };

  const counts = {
    total: leads.length,
    new: leads.filter((l) => l.status === "new").length,
    soa: leads.filter((l) => l.soa_signed).length,
    synced: leads.filter((l) => l.ghl_sync_status === "synced" || l.ghl_sync_status === "mock").length,
    errors: leads.filter((l) => l.ghl_sync_status === "error").length,
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-[1400px] mx-auto w-full px-6 py-8">
        <div className="flex items-end justify-between mb-7">
          <div>
            <div className="text-xs uppercase tracking-widest text-primary mb-2">Lead pipeline</div>
            <h1 className="text-3xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Welcome, {user?.full_name || user?.email}</h1>
            <p className="text-muted-foreground mt-1">Review encrypted intake submissions and sync to GoHighLevel.</p>
          </div>
          {!user?.mfa_enabled && (
            <Link to="/mfa-setup" data-testid="mfa-banner">
              <Button variant="outline" className="rounded-full">
                <ShieldCheck className="w-4 h-4 mr-2 text-primary" /> Enable MFA on your account
              </Button>
            </Link>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-7">
          <StatCard label="Total leads" value={counts.total} />
          <StatCard label="New" value={counts.new} accent />
          <StatCard label="SOA signed" value={counts.soa} icon={FileSignature} />
          <StatCard label="Synced to GHL" value={counts.synced} icon={ShieldCheck} />
          <StatCard label="Sync errors" value={counts.errors} danger icon={AlertCircle} />
        </div>

        <Card className="border-border bg-surface">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, phone..."
                  className="pl-9 h-10"
                  value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && load()}
                  data-testid="lead-search"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44 h-10" data-testid="status-filter"><Filter className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="enrolled">Enrolled</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={load} data-testid="reload-leads">Refresh</Button>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Phone / Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SOA</TableHead>
                    <TableHead>GHL</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading...</TableCell></TableRow>
                  )}
                  {!loading && leads.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No leads yet. New intake submissions will appear here in real time.</TableCell></TableRow>
                  )}
                  {leads.map((l) => (
                    <TableRow key={l.id} className="hover:bg-secondary/40" data-testid={`lead-row-${l.id}`}>
                      <TableCell className="font-medium">
                        <Link to={`/leads/${l.id}`} className="hover:text-primary" data-testid={`lead-link-${l.id}`}>{l.first_name} {l.last_name}</Link>
                        {l.mbi_number && <div className="text-xs text-muted-foreground font-mono">MBI ••••{l.mbi_number.slice(-4)}</div>}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{l.phone || "—"}</div>
                        <div className="text-muted-foreground text-xs">{l.email || ""}</div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`rounded-full capitalize ${STATUS_COLORS[l.status] || "bg-secondary"}`}>{l.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {l.soa_signed
                          ? <span className="text-xs flex items-center gap-1.5 text-primary"><FileSignature className="w-3.5 h-3.5" />Signed</span>
                          : <span className="text-xs text-muted-foreground">Pending</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`w-2 h-2 rounded-full ${SYNC_DOT[l.ghl_sync_status] || "bg-muted"}`} />
                          <span className="capitalize">{l.ghl_sync_status}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <Link to={`/leads/${l.id}`} className="text-primary hover:underline" data-testid={`lead-open-${l.id}`}><ArrowUpRight className="w-4 h-4" /></Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}

function StatCard({ label, value, accent, danger, icon: Icon }) {
  return (
    <Card className={`border-border ${accent ? "bg-primary text-primary-foreground" : danger ? "bg-destructive/10" : "bg-surface"}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest opacity-80">{label}</div>
          {Icon && <Icon className={`w-4 h-4 ${danger ? "text-destructive" : "opacity-70"}`} />}
        </div>
        <div className="text-3xl font-bold mt-2 tabular-nums" style={{fontFamily:'Outfit'}}>{value}</div>
      </CardContent>
    </Card>
  );
}
