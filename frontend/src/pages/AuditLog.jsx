import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, ShieldCheck } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

const TYPE_STYLE = (t) => {
  const s = t || "";
  if (s.includes("failed") || s.includes("error")) return "bg-destructive/10 text-destructive";
  if (s.includes("login_success") || s.includes("synced") || s.includes("signed")) return "bg-emerald-100 text-emerald-900";
  if (s.includes("uploaded") || s.includes("created")) return "bg-secondary text-secondary-foreground";
  return "bg-muted text-muted-foreground";
};

export default function AuditLog() {
  const [events, setEvents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [type, setType] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); loadSummary(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/audit", { params: { event_type: type || undefined, actor_email: email || undefined, limit: 500 } });
      setEvents(Array.isArray(res.data) ? res.data : []);
    } finally { setLoading(false); }
  };
  const loadSummary = async () => {
    const res = await api.get("/audit/summary");
    setSummary(res.data);
  };

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-widest text-primary mb-2">Compliance · Audit log</div>
          <h1 className="text-3xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Audit Trail</h1>
          <p className="text-muted-foreground mt-1">Append-only log of every action that touches a lead, document, or user account.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card className="border-border bg-primary text-primary-foreground"><CardContent className="p-4">
            <div className="text-xs uppercase tracking-widest opacity-80">Total events</div>
            <div className="text-3xl font-bold mt-1 tabular-nums" style={{fontFamily:'Outfit'}}>{summary?.total ?? "—"}</div>
          </CardContent></Card>
          {(summary?.by_event_type || []).slice(0,3).map((b) => (
            <Card key={b.event_type} className="border-border bg-surface"><CardContent className="p-4">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">{(b.event_type || "").replace(/_/g," ")}</div>
              <div className="text-3xl font-bold mt-1 tabular-nums" style={{fontFamily:'Outfit'}}>{b.count}</div>
            </CardContent></Card>
          ))}
        </div>

        <Card className="border-border bg-surface">
          <CardContent className="p-5">
            <div className="flex flex-wrap gap-3 mb-5">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9 h-10" placeholder="Filter by event type (e.g. login_success)" value={type} onChange={(e) => setType(e.target.value)} data-testid="audit-filter-type" />
              </div>
              <Input className="h-10 w-64" placeholder="Filter by actor email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="audit-filter-email" />
              <Button onClick={load} variant="outline" data-testid="audit-apply">Apply</Button>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">Loading...</TableCell></TableRow>}
                  {!loading && (events || []).length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">No events match.</TableCell></TableRow>}
                  {(events || []).map((e) => (
                    <TableRow key={e.id}>
                      <TableCell><Badge className={`rounded-full ${TYPE_STYLE(e.event_type)}`}>{e.event_type}</Badge></TableCell>
                      <TableCell className="text-sm"><div>{e.actor_email || <span className="text-muted-foreground">anonymous</span>}</div>{e.metadata?.reason && <div className="text-xs text-muted-foreground">{e.metadata.reason}</div>}</TableCell>
                      <TableCell className="text-xs">{e.target_type ? <span><span className="capitalize">{e.target_type}</span> · <span className="font-mono">{e.target_id?.slice(0,8)}</span></span> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-xs font-mono">{e.ip_address || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4 text-xs text-muted-foreground flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5 text-primary" /> Logs are append-only. Showing latest 500 events.</div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
