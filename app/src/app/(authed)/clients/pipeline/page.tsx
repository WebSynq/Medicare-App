"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Calendar as CalendarIcon,
  LayoutGrid,
  Mail,
  Phone,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { pipeline as pipelineApi, isApiError } from "@/lib/api";
import type {
  PipelineCard,
  PipelineResponse,
  PipelineStage,
} from "@/lib/api/pipeline";
import { ImpersonationBanner } from "@/components/impersonation-banner";

type Period = "today" | "week" | "month" | "all";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

function periodCutoffMs(period: Period): number | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (period === "today") return now.getTime();
  if (period === "week") return now.getTime() - 7 * 86_400_000;
  if (period === "month") return now.getTime() - 30 * 86_400_000;
  return null;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

export default function PipelinePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [period, setPeriod] = React.useState<Period>("all");
  const [selected, setSelected] = React.useState<{
    card: PipelineCard;
    stageId: string;
  } | null>(null);
  // Dragging state isolated to the page so we can highlight the
  // destination column on hover; lead_id is the draggable id.
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ["pipeline"],
    queryFn: pipelineApi.getPipeline,
  });

  React.useEffect(() => {
    if (query.error) {
      toast.error(
        isApiError(query.error)
          ? query.error.message
          : "Failed to load pipeline",
      );
    }
  }, [query.error]);

  const stageMutation = useMutation({
    mutationFn: (vars: { leadId: string; status: string }) =>
      pipelineApi.updateStage(vars.leadId, vars.status),
  });

  // Period filter applied client-side against card.created_at so the
  // user can flip the toggle without a backend round-trip.
  const stages: PipelineStage[] = React.useMemo(() => {
    const raw = query.data?.stages ?? [];
    const cutoff = periodCutoffMs(period);
    if (cutoff == null) return raw;
    return raw.map((stage) => {
      const leads = stage.leads.filter((card) => {
        const t = card.created_at ? new Date(card.created_at).getTime() : 0;
        return t >= cutoff;
      });
      const total = leads.reduce(
        (acc, c) => acc + (c.estimated_commission ?? 0),
        0,
      );
      return {
        ...stage,
        leads,
        count: leads.length,
        total_commission: total,
      };
    });
  }, [query.data, period]);

  const summary = React.useMemo(() => {
    const totalLeads = stages.reduce((acc, s) => acc + s.count, 0);
    const totalValue = stages.reduce(
      (acc, s) => acc + s.total_commission,
      0,
    );
    return { total_leads: totalLeads, total_pipeline_value: totalValue };
  }, [stages]);

  function moveCard(card: PipelineCard, fromStageId: string, toStageId: string) {
    if (fromStageId === toStageId) return;
    const snapshot = queryClient.getQueryData<PipelineResponse>(["pipeline"]);
    if (!snapshot) return;

    // Optimistic move — drop from source, prepend to destination.
    const nextStages = snapshot.stages.map((s) => {
      if (s.id === fromStageId) {
        return {
          ...s,
          leads: s.leads.filter((c) => c.lead_id !== card.lead_id),
        };
      }
      if (s.id === toStageId) {
        return { ...s, leads: [card, ...s.leads] };
      }
      return s;
    });
    queryClient.setQueryData<PipelineResponse>(["pipeline"], {
      ...snapshot,
      stages: nextStages,
    });

    stageMutation.mutate(
      { leadId: card.lead_id, status: toStageId },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData<PipelineResponse>(["pipeline"], (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              stages: prev.stages.map((s) =>
                s.id === toStageId
                  ? {
                      ...s,
                      leads: s.leads.map((c) =>
                        c.lead_id === card.lead_id ? { ...c, ...updated } : c,
                      ),
                    }
                  : s,
              ),
            };
          });
          const stageLabel =
            snapshot.stages.find((s) => s.id === toStageId)?.label ?? toStageId;
          toast.success(`${card.full_name} moved to ${stageLabel}`);
          setSelected(null);
        },
        onError: (err) => {
          queryClient.setQueryData<PipelineResponse>(["pipeline"], snapshot);
          toast.error(
            isApiError(err) ? err.message : "Failed to move card",
          );
        },
      },
    );
  }

  function findStageOf(leadId: string): string | null {
    const raw = query.data?.stages ?? [];
    for (const s of raw) {
      if (s.leads.some((c) => c.lead_id === leadId)) return s.id;
    }
    return null;
  }

  return (
    <div className="max-w-[1600px] mx-auto space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <LayoutGrid className="h-4 w-4 text-primary" />
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Pipeline
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight font-display flex flex-wrap items-center gap-2">
            <span>Pipeline</span>
            <Badge variant="secondary" className="text-xs tabular-nums">
              {summary.total_leads} leads
            </Badge>
            {summary.total_pipeline_value > 0 && (
              <Badge
                variant="outline"
                className="text-xs tabular-nums bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
              >
                {fmtMoney(summary.total_pipeline_value)} Est.
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Drag cards between columns, or open one for full details and
            quick actions.
          </p>
          <ImpersonationBanner />
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-40 h-9">
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
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {query.isLoading && !query.data ? (
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[420px] w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col md:flex-row md:overflow-x-auto gap-3 pb-4">
          {stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              draggingId={draggingId}
              isDragOver={dragOverStage === stage.id}
              onDragStart={(card) => setDraggingId(card.lead_id)}
              onDragEnd={() => {
                setDraggingId(null);
                setDragOverStage(null);
              }}
              onDragEnter={() => setDragOverStage(stage.id)}
              onDrop={(leadId) => {
                const fromStageId = findStageOf(leadId);
                if (!fromStageId) return;
                const sourceStage = stages.find((s) => s.id === fromStageId);
                const card = sourceStage?.leads.find(
                  (c) => c.lead_id === leadId,
                );
                if (!card) return;
                moveCard(card, fromStageId, stage.id);
              }}
              onCardClick={(card) =>
                setSelected({ card, stageId: stage.id })
              }
            />
          ))}
        </div>
      )}

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-md overflow-y-auto"
        >
          {selected && (
            <CardSheetBody
              card={selected.card}
              stageId={selected.stageId}
              stages={stages}
              saving={stageMutation.isPending}
              onMove={(toStageId) =>
                moveCard(selected.card, selected.stageId, toStageId)
              }
              onClose={() => setSelected(null)}
              onNavigate={(href) => {
                setSelected(null);
                router.push(href);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StageColumn({
  stage,
  draggingId,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onCardClick,
}: {
  stage: PipelineStage;
  draggingId: string | null;
  isDragOver: boolean;
  onDragStart: (card: PipelineCard) => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDrop: (leadId: string) => void;
  onCardClick: (card: PipelineCard) => void;
}) {
  return (
    <div className="flex-shrink-0 w-full md:w-72 flex flex-col">
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
            variant="outline"
            className="text-[10px]"
            style={{ borderColor: `${stage.color}40`, color: stage.color }}
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
        className={cn(
          "flex-1 overflow-hidden transition-colors",
          isDragOver && "ring-2 ring-primary/40",
        )}
        style={{
          borderTop: `2px solid ${stage.color}`,
          background: isDragOver ? `${stage.color}10` : undefined,
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDragEnter={onDragEnter}
        onDrop={(e) => {
          e.preventDefault();
          const leadId = e.dataTransfer.getData("text/lead-id");
          if (leadId) onDrop(leadId);
        }}
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
                isDragging={draggingId === card.lead_id}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/lead-id", card.lead_id);
                  e.dataTransfer.effectAllowed = "move";
                  onDragStart(card);
                }}
                onDragEnd={onDragEnd}
                onClick={() => onCardClick(card)}
              />
            ))
          )}
          {stage.truncated && (
            <p className="text-[11px] text-muted-foreground italic px-2 pt-1 text-center">
              Showing first {stage.cap} of {stage.count.toLocaleString()} —
              use filters to narrow
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LeadCard({
  card,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
}: {
  card: PipelineCard;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick();
      }}
      className={cn(
        "w-full text-left rounded-md border bg-card px-3 py-2.5 transition-all",
        isDragging
          ? "border-primary shadow-lg scale-[1.02] opacity-60"
          : "border-border hover:border-primary/40 hover:shadow-sm cursor-grab",
      )}
    >
      <div className="font-medium text-sm truncate">{card.full_name}</div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        {card.phone && (
          <span className="flex items-center gap-1.5 truncate">
            <Phone className="h-2.5 w-2.5 flex-shrink-0" />
            {card.phone}
          </span>
        )}
        {card.email && (
          <span className="flex items-center gap-1.5 truncate">
            <Mail className="h-2.5 w-2.5 flex-shrink-0" />
            {card.email}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {card.carrier && (
          <Badge variant="secondary" className="text-[9px] font-normal">
            {card.carrier}
          </Badge>
        )}
        {card.product_type && (
          <Badge variant="secondary" className="text-[9px] font-normal">
            {card.product_type}
          </Badge>
        )}
        {card.state && (
          <Badge variant="secondary" className="text-[9px] font-normal">
            {card.state}
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(card.created_at)}
        </span>
        {card.estimated_commission != null && (
          <span className="text-[11px] font-semibold text-ghw-forest tabular-nums">
            {fmtMoney(card.estimated_commission)}
          </span>
        )}
      </div>
      {card.agent_name && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate">
          @ {card.agent_name}
        </div>
      )}
    </div>
  );
}

function CardSheetBody({
  card,
  stageId,
  stages,
  saving,
  onMove,
  onClose,
  onNavigate,
}: {
  card: PipelineCard;
  stageId: string;
  stages: PipelineStage[];
  saving: boolean;
  onMove: (toStageId: string) => void;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  return (
    <>
      <SheetHeader className="mb-4">
        <SheetTitle>{card.full_name}</SheetTitle>
        <SheetDescription>
          Move this lead between stages or jump into the full profile.
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-3 text-sm">
        {card.phone && (
          <div className="flex items-center gap-2">
            <Phone className="h-3.5 w-3.5 text-muted-foreground" />
            <a href={`tel:${card.phone}`} className="hover:underline">
              {card.phone}
            </a>
          </div>
        )}
        {card.email && (
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <a
              href={`mailto:${card.email}`}
              className="hover:underline truncate"
            >
              {card.email}
            </a>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {card.carrier && (
            <Badge variant="secondary" className="text-[10px]">
              {card.carrier}
            </Badge>
          )}
          {card.product_type && (
            <Badge variant="secondary" className="text-[10px]">
              {card.product_type}
            </Badge>
          )}
          {card.state && (
            <Badge variant="secondary" className="text-[10px]">
              {card.state}
            </Badge>
          )}
        </div>

        <div className="pt-2 border-t border-border">
          <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
            Move to Stage
          </label>
          <Select
            value={stageId}
            onValueChange={(next) => onMove(next)}
            disabled={saving}
          >
            <SelectTrigger className="h-10">
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
            Drag cards between columns or use this dropdown.
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => onNavigate(`/clients/${card.lead_id}`)}
          >
            View Full Profile
            <ArrowUpRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              onNavigate(`/appointments?lead_id=${card.lead_id}`)
            }
          >
            <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
            Book Appointment
          </Button>
          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </>
  );
}

