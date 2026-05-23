import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  LayoutGrid,
  Phone,
  Mail,
  ArrowUpRight,
  Calendar as CalendarIcon,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api, auth } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import LeadNotesPanel from "@/components/LeadNotesPanel";

// Period filter — applied client-side against card.created_at so we
// avoid an extra backend round-trip when the user flips the toggle.
const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

function periodCutoff(period) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (period === "today") return now;
  if (period === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (period === "month") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d;
  }
  return null;
}

function fmtMoney(v) {
  if (v == null) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

function timeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

function LeadCard({ card, onClick, showAgent }) {
  return (
    <button
      type="button"
      onClick={() => onClick(card)}
      className="w-full text-left rounded-md border border-border bg-surface px-3 py-2.5 hover:border-[#e85d2f]/40 hover:shadow-sm transition-all"
      data-testid={`pipeline-card-${card.lead_id}`}
    >
      <div className="font-medium text-sm truncate">{card.full_name}</div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        {card.phone && (
          <span className="flex items-center gap-1.5 truncate">
            <Phone className="w-2.5 h-2.5 flex-shrink-0" />
            {card.phone}
          </span>
        )}
        {card.email && (
          <span className="flex items-center gap-1.5 truncate">
            <Mail className="w-2.5 h-2.5 flex-shrink-0" />
            {card.email}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {card.carrier && (
          <Badge className="rounded-full text-[9px] bg-secondary text-foreground/75 border-0">
            {card.carrier}
          </Badge>
        )}
        {card.product_type && (
          <Badge className="rounded-full text-[9px] bg-secondary text-foreground/75 border-0">
            {card.product_type}
          </Badge>
        )}
        {card.state && (
          <Badge className="rounded-full text-[9px] bg-secondary text-foreground/75 border-0">
            {card.state}
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(card.created_at)}
        </span>
        {card.estimated_commission != null && (
          <span className="text-[11px] font-semibold text-emerald-700 tabular-nums">
            {fmtMoney(card.estimated_commission)}
          </span>
        )}
      </div>
      {showAgent && card.agent_name && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate">
          @ {card.agent_name}
        </div>
      )}
    </button>
  );
}

function StageColumn({ stage, onCardClick, showAgent }) {
  return (
    <div className="flex-shrink-0 w-72 md:w-72 flex flex-col">
      <div className="flex items-center justify-between gap-2 px-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: stage.color }}
          />
          <span
            className="text-xs font-semibold uppercase tracking-widest truncate"
            style={{ color: stage.color }}
          >
            {stage.label}
          </span>
          <Badge
            className="rounded-full text-[10px] border-0 flex-shrink-0"
            style={{
              background: `${stage.color}1f`,
              color: stage.color,
            }}
          >
            {stage.count}
          </Badge>
        </div>
        {stage.total_commission > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {fmtMoney(stage.total_commission)}
          </span>
        )}
      </div>
      <Card
        className="bg-surface flex-1 overflow-hidden"
        style={{ borderTop: `2px solid ${stage.color}` }}
      >
        <CardContent
          className="p-2 space-y-2 overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 320px)" }}
        >
          {stage.leads.length === 0 ? (
            <div className="text-center text-[11px] text-muted-foreground py-8">
              No leads in this stage
            </div>
          ) : (
            stage.leads.map((card) => (
              <LeadCard
                key={card.lead_id}
                card={card}
                onClick={onCardClick}
                showAgent={showAgent}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CardSheet({ open, onOpenChange, card, stages, onStageChange, saving }) {
  const navigate = useNavigate();
  if (!card) return null;

  const currentStage = stages.find(
    (s) => s.leads.some((c) => c.lead_id === card.lead_id),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle>{card.full_name}</SheetTitle>
          <SheetDescription>
            Move this lead between stages or jump into the full profile.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 text-sm">
          {card.phone && (
            <div className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-muted-foreground" />
              <a href={`tel:${card.phone}`} className="hover:underline">
                {card.phone}
              </a>
            </div>
          )}
          {card.email && (
            <div className="flex items-center gap-2">
              <Mail className="w-3.5 h-3.5 text-muted-foreground" />
              <a href={`mailto:${card.email}`} className="hover:underline truncate">
                {card.email}
              </a>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {card.carrier && (
              <Badge className="rounded-full text-[10px] bg-secondary text-foreground/80 border-0">
                {card.carrier}
              </Badge>
            )}
            {card.product_type && (
              <Badge className="rounded-full text-[10px] bg-secondary text-foreground/80 border-0">
                {card.product_type}
              </Badge>
            )}
            {card.state && (
              <Badge className="rounded-full text-[10px] bg-secondary text-foreground/80 border-0">
                {card.state}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <div>
              <div className="uppercase tracking-widest text-[10px]">Created</div>
              <div className="text-foreground text-xs">{timeAgo(card.created_at)}</div>
            </div>
            <div>
              <div className="uppercase tracking-widest text-[10px]">Updated</div>
              <div className="text-foreground text-xs">{timeAgo(card.updated_at)}</div>
            </div>
            {card.agent_name && (
              <div>
                <div className="uppercase tracking-widest text-[10px]">Agent</div>
                <div className="text-foreground text-xs truncate">{card.agent_name}</div>
              </div>
            )}
            {card.client_success_rep && (
              <div>
                <div className="uppercase tracking-widest text-[10px]">CS Rep</div>
                <div className="text-foreground text-xs truncate">
                  {card.client_success_rep}
                </div>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-border">
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Move to Stage
            </label>
            <Select
              value={currentStage?.id || ""}
              onValueChange={(next) => onStageChange(card, next)}
              disabled={saving}
            >
              <SelectTrigger className="h-10" data-testid="pipeline-stage-select">
                <SelectValue placeholder="Pick a stage" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: s.color }}
                      />
                      {s.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-1">
              Drag-and-drop coming soon — picking a stage moves the card
              now.
            </p>
          </div>

          <div className="pt-3 border-t border-border">
            <LeadNotesPanel leadId={card.lead_id} compact />
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                navigate(`/clients/${card.lead_id}`);
              }}
              data-testid="pipeline-view-profile"
            >
              View Full Profile
              <ArrowUpRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                navigate(`/appointments?lead_id=${card.lead_id}`);
              }}
              data-testid="pipeline-book-appointment"
            >
              <CalendarIcon className="w-3.5 h-3.5 mr-1.5" />
              Book Appointment
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Pipeline() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("all");
  const [selected, setSelected] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savingStage, setSavingStage] = useState(false);

  const user = auth.getUser();
  const showAgent =
    user?.role === "admin" ||
    user?.role === "compliance" ||
    user?.role === "coach" ||
    user?.role === "accounting" ||
    user?.role === "client_success";

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/leads/pipeline");
      setData(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load pipeline");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Apply the period filter client-side. Recomputes counts +
  // total_commission per stage so the column headers reflect the
  // current window without a backend round-trip.
  const stages = useMemo(() => {
    if (!data?.stages) return [];
    const cutoff = periodCutoff(period);
    if (!cutoff) return data.stages;
    const cutoffMs = cutoff.getTime();
    return data.stages.map((s) => {
      const filtered = s.leads.filter((c) => {
        const t = c.created_at ? new Date(c.created_at).getTime() : 0;
        return t >= cutoffMs;
      });
      const total = filtered.reduce(
        (acc, c) => acc + (c.estimated_commission || 0),
        0,
      );
      return {
        ...s,
        leads: filtered,
        count: filtered.length,
        total_commission: total,
      };
    });
  }, [data, period]);

  const summary = useMemo(() => {
    const totalLeads = stages.reduce((acc, s) => acc + s.count, 0);
    const totalValue = stages.reduce(
      (acc, s) => acc + s.total_commission,
      0,
    );
    return {
      total_leads: totalLeads,
      total_pipeline_value: totalValue,
    };
  }, [stages]);

  function openCard(card) {
    setSelected(card);
    setSheetOpen(true);
  }

  // Optimistic stage move. On API failure we revert to the snapshot
  // taken before the move so the UI doesn't drift from server state.
  async function moveCardToStage(card, nextStageId) {
    if (!data) return;
    const fromStageId = stages.find((s) =>
      s.leads.some((c) => c.lead_id === card.lead_id),
    )?.id;
    if (!fromStageId || fromStageId === nextStageId) return;

    const snapshot = data;
    const nextData = {
      ...data,
      stages: data.stages.map((s) => {
        if (s.id === fromStageId) {
          return { ...s, leads: s.leads.filter((c) => c.lead_id !== card.lead_id) };
        }
        if (s.id === nextStageId) {
          return { ...s, leads: [card, ...s.leads] };
        }
        return s;
      }),
    };
    setData(nextData);
    setSavingStage(true);

    try {
      const res = await api.patch(`/leads/${card.lead_id}/stage`, {
        status: nextStageId,
      });
      // Server returns the updated card — fold it back so any
      // server-derived fields (updated_at) refresh.
      const updated = res.data;
      setData((d) => ({
        ...d,
        stages: d.stages.map((s) =>
          s.id === nextStageId
            ? {
                ...s,
                leads: s.leads.map((c) =>
                  c.lead_id === card.lead_id ? { ...c, ...updated } : c,
                ),
              }
            : s,
        ),
      }));
      toast.success(
        `${card.full_name} moved to ${stages.find((s) => s.id === nextStageId)?.label || nextStageId}`,
      );
      setSheetOpen(false);
    } catch (err) {
      // Roll back to snapshot
      setData(snapshot);
      toast.error(err?.response?.data?.detail || "Failed to move card");
    } finally {
      setSavingStage(false);
    }
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1600px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <LayoutGrid className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Pipeline
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight flex flex-wrap items-center gap-2"
              style={{ fontFamily: "Outfit" }}
            >
              <span>Pipeline</span>
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
                style={{ background: "rgba(30,45,61,0.08)", color: "#1e2d3d" }}
              >
                {summary.total_leads} leads
              </span>
              {summary.total_pipeline_value > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
                  style={{ background: "rgba(22,163,74,0.12)", color: "#166534" }}
                >
                  {fmtMoney(summary.total_pipeline_value)} Est.
                </span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Drag-style Kanban — pick a card and move it through the
              stages with the Move to Stage selector.
            </p>
            <ImpersonationBanner />
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-40 h-10" data-testid="pipeline-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading}
              data-testid="pipeline-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {loading && !data ? (
          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={i}
                className="h-[420px] rounded bg-secondary/40 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="flex md:flex-row flex-col gap-4 md:overflow-x-auto pb-4">
            {stages.map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                onCardClick={openCard}
                showAgent={showAgent}
              />
            ))}
          </div>
        )}
      </main>

      <CardSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) setSelected(null);
        }}
        card={selected}
        stages={stages}
        onStageChange={moveCardToStage}
        saving={savingStage}
      />
    </div>
  );
}
