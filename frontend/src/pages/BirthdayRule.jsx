import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cake, Info, Phone, Send } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import ScrollableCard from "@/components/ScrollableCard";
import ImpersonationBanner from "@/components/ImpersonationBanner";

// Per-section accent. Matches the spec's red/amber/blue urgency
// mapping while staying inside the GHW palette.
const SECTIONS = [
  {
    key: "urgent",
    title: "Window Open Now",
    subtitle:
      "Birthday window is currently active — switch without underwriting.",
    border: "border-l-4 border-rose-500",
    badge: "bg-rose-100 text-rose-900",
  },
  {
    key: "soon",
    title: "Coming Up — 90 Days",
    subtitle: "Birthdays in the next 90 days — start the conversation now.",
    border: "border-l-4 border-amber-500",
    badge: "bg-amber-100 text-amber-900",
  },
  {
    key: "upcoming",
    title: "On The Horizon — 180 Days",
    subtitle: "Birthdays 90–180 days out — keep these on your radar.",
    border: "border-l-4 border-blue-500",
    badge: "bg-blue-100 text-blue-900",
  },
];

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function BirthdayRule() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/birthday-rule/alerts");
      setData(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not load birthday alerts",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Cake className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Illinois
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Illinois Birthday Rule Tracker
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              63-day switch window after a client&rsquo;s birthday — no
              underwriting required.
            </p>
            <ImpersonationBanner />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        <Card
          className="bg-amber-50 border-amber-200 mb-4"
          data-testid="birthday-info-banner"
        >
          <CardContent className="p-4 flex items-start gap-3 text-xs">
            <Info className="w-4 h-4 mt-0.5 text-amber-700 flex-shrink-0" />
            <p className="text-amber-900 leading-snug">
              Illinois law allows Med Supp clients to switch plans without
              underwriting during the 63 days following their birthday.
              Contact these clients now.
            </p>
          </CardContent>
        </Card>

        {SECTIONS.map((s) => {
          const rows = (data || {})[s.key] || [];
          return (
            <div key={s.key} className="mb-4">
              <ScrollableCard
                title={s.title}
                count={rows.length}
                height="320px"
                loading={loading}
                isEmpty={!loading && rows.length === 0}
                emptyState={
                  s.key === "urgent"
                    ? "No clients in an open window right now."
                    : "No clients in this range."
                }
                testId={`birthday-${s.key}-card`}
              >
                <div className={`p-4 space-y-2 ${s.border}`}>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    {s.subtitle}
                  </p>
                  {rows.map((r) => (
                    <div
                      key={r.lead_id || r.full_name}
                      className="rounded-md border border-border p-3 bg-background flex flex-wrap items-start justify-between gap-3"
                      data-testid={`birthday-row-${s.key}-${r.lead_id || ""}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={`/clients/${r.lead_id || ""}`}
                            className="font-medium text-sm hover:text-[#e85d2f] truncate"
                          >
                            {r.full_name}
                          </Link>
                          <Badge
                            className={`rounded-full border-0 text-[10px] ${s.badge}`}
                          >
                            {s.key === "urgent"
                              ? `${r.days_remaining_in_window} days left in window`
                              : `${r.days_until_birthday} days until birthday`}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          <span>DOB: {fmtDate(r.date_of_birth)}</span>
                          {r.current_plan && (
                            <span>Plan: {r.current_plan}</span>
                          )}
                          {r.current_carrier && (
                            <span>Carrier: {r.current_carrier}</span>
                          )}
                          {r.phone && <span>{r.phone}</span>}
                          {r.agent_name && (
                            <span className="opacity-80">
                              · {r.agent_name}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {r.phone && s.key === "urgent" && (
                          <Button
                            asChild
                            size="sm"
                            className="h-7 text-xs text-white"
                            style={{
                              background:
                                "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                            }}
                          >
                            <a href={`tel:${r.phone}`}>
                              <Phone className="w-3 h-3 mr-1" /> Call Now
                            </a>
                          </Button>
                        )}
                        {r.lead_id && (
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                          >
                            <Link to={`/clients/${r.lead_id}`}>
                              <Send className="w-3 h-3 mr-1" />
                              {s.key === "urgent" ? "Send SOA" : "Schedule"}
                            </Link>
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollableCard>
            </div>
          );
        })}
      </main>
    </div>
  );
}
