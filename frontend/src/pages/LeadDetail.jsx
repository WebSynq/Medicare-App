import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Cable, Download, FileSignature, ShieldCheck, ArrowLeft, RefreshCw, FileText } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

export default function LeadDetail() {
  const { id } = useParams();
  const [lead, setLead] = useState(null);
  const [docs, setDocs] = useState([]);
  const [soa, setSoa] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  const load = async () => {
    try {
      const [l, d] = await Promise.all([
        api.get(`/leads/${id}`),
        api.get(`/documents/by-lead/${id}`),
      ]);
      setLead(l.data); setDocs(d.data);
      try { const s = await api.get(`/soa/by-lead/${id}`); setSoa(s.data); } catch (_) { setSoa(null); }
    } catch (e) { toast.error("Failed to load lead"); }
  };

  const updateStatus = async (s) => {
    try {
      const res = await api.patch(`/leads/${id}`, { status: s });
      setLead(res.data); toast.success("Status updated");
    } catch (e) { toast.error("Update failed"); }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await api.post(`/leads/${id}/sync-ghl`);
      setLead(res.data);
      toast.success(res.data.ghl_sync_status === "mock" ? "Synced (mock — set GHL_PRIVATE_TOKEN to enable live sync)" : "Synced to GoHighLevel");
    } catch (e) { toast.error(e?.response?.data?.detail || "Sync failed"); }
    finally { setSyncing(false); }
  };

  const download = async (doc) => {
    try {
      const res = await api.get(`/documents/${doc.id}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = doc.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error("Download failed"); }
  };

  const downloadPdf = async () => {
    try {
      const res = await api.get(`/leads/${id}/pdf`, { responseType: "blob" });
      const disposition = res.headers?.["content-disposition"] || "";
      const match = /filename\s*=\s*"?([^"]+)"?/i.exec(disposition);
      const fallback = `lead_${(lead.first_name || "").trim()}_${(lead.last_name || "").trim()}.pdf`.replace(/\s+/g, "_");
      const filename = match?.[1] || fallback;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error("PDF export failed"); }
  };

  if (!lead) return <div className="p-6 md:p-8"><div className="max-w-5xl mx-auto text-muted-foreground">Loading...</div></div>;

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-5xl mx-auto w-full">
        <Link to="/dashboard" className="text-sm text-muted-foreground inline-flex items-center hover:text-primary mb-4" data-testid="back-to-dashboard"><ArrowLeft className="w-4 h-4 mr-1" />Back to leads</Link>

        <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
          <div>
            <Badge className="rounded-full bg-secondary text-secondary-foreground border-0 mb-2">Lead · {id.slice(0,8)}</Badge>
            <h1 className="text-3xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>{lead.first_name} {lead.last_name}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{lead.email || "—"} · {lead.phone || "—"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={lead.status} onValueChange={updateStatus}>
              <SelectTrigger className="w-40" data-testid="status-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="qualified">Qualified</SelectItem>
                <SelectItem value="enrolled">Enrolled</SelectItem>
                <SelectItem value="lost">Lost</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={downloadPdf} className="rounded-full" data-testid="download-pdf-btn">
              <Download className="w-4 h-4 mr-2" />
              Download PDF
            </Button>
            <Button onClick={sync} disabled={syncing} className="rounded-full" data-testid="sync-ghl-btn">
              {syncing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Cable className="w-4 h-4 mr-2" />}
              Sync to GHL
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-5">
            <Card className="border-border bg-surface">
              <CardContent className="p-6">
                <h3 className="text-sm font-semibold mb-4 uppercase tracking-widest text-muted-foreground">Personal &amp; Medicare</h3>
                <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                  <KV label="Date of birth" v={lead.date_of_birth} />
                  <KV label="MBI" v={lead.mbi_number ? <span className="font-mono">{lead.mbi_number}</span> : null} />
                  <KV label="Part A effective" v={lead.medicare_part_a_effective} />
                  <KV label="Part B effective" v={lead.medicare_part_b_effective} />
                  <KV label="Current carrier" v={lead.current_carrier} />
                  <KV label="Current plan" v={lead.current_plan} />
                  <KV label="Address" v={[lead.address_line1, lead.city, lead.state, lead.zip_code].filter(Boolean).join(", ")} />
                  <KV label="Preferred contact" v={lead.preferred_contact_time} />
                  <KV label="Doctors" v={lead.doctors?.join(", ")} fullWidth />
                  <KV label="Prescriptions" v={lead.prescriptions?.join(", ")} fullWidth />
                  <KV label="Notes" v={lead.notes} fullWidth />
                </dl>
              </CardContent>
            </Card>

            <Card className="border-border bg-surface">
              <CardContent className="p-6">
                <h3 className="text-sm font-semibold mb-4 uppercase tracking-widest text-muted-foreground">Encrypted documents ({docs.length})</h3>
                {docs.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No documents uploaded.</div>
                ) : (
                  <ul className="divide-y divide-border">
                    {docs.map((d) => (
                      <li key={d.id} className="py-3 flex items-center justify-between" data-testid={`doc-row-${d.id}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-md bg-secondary grid place-items-center"><FileText className="w-4 h-4 text-primary" /></div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{d.filename}</div>
                            <div className="text-xs text-muted-foreground capitalize">{d.doc_type.replace("_"," ")} · {(d.size_bytes/1024).toFixed(1)} KB · encrypted</div>
                          </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => download(d)} data-testid={`doc-download-${d.id}`}>
                          <Download className="w-3.5 h-3.5 mr-1.5" /> Download
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="border-border bg-surface">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">GHL Sync</h3>
                  <span className={`w-2 h-2 rounded-full ${lead.ghl_sync_status === "synced" || lead.ghl_sync_status === "mock" ? "bg-emerald-500" : lead.ghl_sync_status === "error" ? "bg-destructive" : "bg-amber-500"}`} />
                </div>
                <div className="text-sm capitalize">{lead.ghl_sync_status}</div>
                {lead.ghl_contact_id && <div className="text-xs text-muted-foreground mt-1 font-mono break-all">{lead.ghl_contact_id}</div>}
                {lead.ghl_synced_at && <div className="text-xs text-muted-foreground mt-1">Last: {new Date(lead.ghl_synced_at).toLocaleString()}</div>}
                {lead.ghl_sync_error && <div className="text-xs text-destructive mt-2 break-all">{lead.ghl_sync_error}</div>}
              </CardContent>
            </Card>

            <Card className="border-border bg-surface">
              <CardContent className="p-6">
                <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">SOA</h3>
                {soa ? (
                  <div>
                    <div className="flex items-center gap-2 mb-3 text-sm"><FileSignature className="w-4 h-4 text-primary" /><span>Signed {new Date(soa.signed_at).toLocaleString()}</span></div>
                    <div className="rounded-md border border-border bg-white p-2"><img src={soa.signature_data_url} alt="Signature" className="max-h-28 mx-auto" data-testid="soa-image" /></div>
                    <div className="text-xs text-muted-foreground mt-2">Plan types: {soa.plan_types_discussed?.join(", ") || "—"}</div>
                    <div className="text-xs text-muted-foreground">IP: {soa.ip_address || "—"}</div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">SOA not on file.</div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border bg-secondary/40">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 text-xs"><ShieldCheck className="w-4 h-4 text-primary" /><span className="font-medium">Audit trail active</span></div>
                <p className="text-xs text-muted-foreground mt-1.5">All access events on this lead are recorded. Compliance officers can review in <Link to="/audit" className="text-primary hover:underline">Audit Log</Link>.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function KV({ label, v, fullWidth }) {
  return (
    <div className={`min-w-0 ${fullWidth ? "sm:col-span-2" : ""}`}>
      <dt className="text-xs uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground break-words">{v || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}
