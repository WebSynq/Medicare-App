"use client";

/**
 * Disputes tab — open/in-progress/resolved tracking + AI dispute
 * letter generation.
 *
 * - 4 stat cards (Open / In Progress / Resolved / Recovered MTD)
 * - Disputes table with per-row status updater + Letter button
 * - "New Dispute" modal (parent passes `forceOpen` so the
 *   Carriers tab can pre-open it via the per-card CTA)
 * - Letter modal — AI-generated text, copy + download
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileText,
  Plus,
  RefreshCcw,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { accounting } from "@/lib/api";
import type {
  CreateDisputePayload,
  DisputeStatus,
  DisputesResponse,
} from "@/lib/api/accounting";

import { fmt, fmtDate, fmtShort } from "./_helpers";
import { DisputeStatusBadge } from "./_status-badges";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

interface DisputesTabProps {
  /** Carriers tab pings this from setForceCreateOpen(true) to open
   *  the Create Dispute modal from outside this tab. */
  forceCreateOpen: boolean;
  onCreateOpened: () => void;
}

export function DisputesTab({
  forceCreateOpen,
  onCreateOpened,
}: DisputesTabProps) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [letter, setLetter] = React.useState<{
    disputeId: string;
    text: string;
  } | null>(null);

  React.useEffect(() => {
    if (forceCreateOpen) {
      setCreateOpen(true);
      onCreateOpened();
    }
  }, [forceCreateOpen, onCreateOpened]);

  const query = useQuery<DisputesResponse>({
    queryKey: ["accounting", "disputes"],
    queryFn: () => accounting.getDisputes(),
  });

  const counts = query.data?.counts ?? {
    open: 0,
    in_progress: 0,
    resolved: 0,
    closed: 0,
  };
  const items = query.data?.items ?? [];
  const loading = query.isLoading;

  async function changeStatus(id: string, status: DisputeStatus) {
    try {
      await accounting.updateDispute(id, { status });
      toast.success(`Marked ${status.replace("_", " ")}`);
      query.refetch();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Update failed");
    }
  }

  async function generateLetter(id: string) {
    try {
      // /disputes/{id}/letter streams text/plain — axios JSON-parses
      // by default, so we drop down to fetch like the CFO chat path.
      const resp = await fetch(
        `${BACKEND_URL}/api/accounting/disputes/${id}/letter`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "X-CSRF-Token": readCsrf() ?? "",
          },
        },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      setLetter({ disputeId: id, text });
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Letter generation failed");
    }
  }

  return (
    <div className="space-y-3">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Open" value={counts.open} accent="text-ghw-copper" />
        <StatCard
          title="In Progress"
          value={counts.in_progress}
          accent="text-primary"
        />
        <StatCard
          title="Resolved"
          value={counts.resolved}
          accent="text-ghw-forest"
        />
        <StatCard
          title="Recovered MTD"
          value={fmtShort(query.data?.total_recovered_mtd)}
          accent="text-ghw-forest"
        />
      </div>

      {/* Action row */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {items.length} dispute{items.length === 1 ? "" : "s"}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={loading}
          >
            <RefreshCcw
              className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            data-testid="open-create-dispute"
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            New Dispute
          </Button>
        </div>
      </div>

      {/* Disputes table */}
      <Card>
        <CardContent className="p-0">
          {loading && items.length === 0 ? (
            <div className="p-6">
              <Skeleton className="h-32 w-full" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">
              No disputes on file.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Days Open</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((d) => (
                    <TableRow key={d.dispute_id}>
                      <TableCell className="text-xs">
                        {fmtDate(d.created_at)}
                      </TableCell>
                      <TableCell className="text-xs">{d.carrier}</TableCell>
                      <TableCell className="text-xs">
                        {d.agent_name || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {d.client_name || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {fmt(d.amount_disputed)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {d.days_open}
                      </TableCell>
                      <TableCell>
                        <DisputeStatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          <Select
                            onValueChange={(v) =>
                              changeStatus(d.dispute_id, v as DisputeStatus)
                            }
                          >
                            <SelectTrigger className="h-7 w-32 text-xs">
                              <SelectValue placeholder="Update" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="open">Open</SelectItem>
                              <SelectItem value="in_progress">
                                In Progress
                              </SelectItem>
                              <SelectItem value="resolved">Resolved</SelectItem>
                              <SelectItem value="closed">Closed</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => generateLetter(d.dispute_id)}
                            data-testid={`letter-${d.dispute_id}`}
                          >
                            <FileText className="w-3 h-3 mr-1" />
                            Letter
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateDisputeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          query.refetch();
        }}
      />

      <LetterModal
        letter={letter}
        onClose={() => setLetter(null)}
      />
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  accent,
}: {
  title: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <Card data-testid={`dispute-stat-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {title}
        </div>
        <div
          className={cn(
            "mt-1 text-2xl font-bold tabular-nums font-display",
            accent,
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Create dispute modal ────────────────────────────────────────────────

function CreateDisputeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [carrier, setCarrier] = React.useState("");
  const [policyId, setPolicyId] = React.useState("");
  const [agentName, setAgentName] = React.useState("");
  const [clientName, setClientName] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Reset state on open so reopening doesn't show the previous draft.
  React.useEffect(() => {
    if (open) {
      setCarrier("");
      setPolicyId("");
      setAgentName("");
      setClientName("");
      setAmount("");
      setReason("");
      setNotes("");
    }
  }, [open]);

  async function save() {
    if (!carrier.trim()) {
      toast.error("Carrier is required");
      return;
    }
    setSaving(true);
    try {
      const payload: CreateDisputePayload = {
        carrier: carrier.trim(),
        policy_id: policyId.trim() || null,
        agent_name: agentName.trim() || null,
        client_name: clientName.trim() || null,
        amount_disputed: Number(amount) || 0,
        reason: reason.trim(),
        notes: notes.trim() || null,
      };
      await accounting.createDispute(payload);
      toast.success("Dispute created");
      onCreated();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Failed to create dispute");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Commission Dispute</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Carrier *</Label>
            <Input
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              data-testid="dispute-carrier"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Policy #</Label>
              <Input
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              />
            </div>
            <div>
              <Label>Amount disputed</Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="dispute-amount"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Agent</Label>
              <Input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
            </div>
            <div>
              <Label>Client</Label>
              <Input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving}
              data-testid="dispute-save"
            >
              {saving ? "Saving…" : "Create dispute"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Letter modal ────────────────────────────────────────────────────────

function LetterModal({
  letter,
  onClose,
}: {
  letter: { disputeId: string; text: string } | null;
  onClose: () => void;
}) {
  if (!letter) return null;

  function copy() {
    navigator.clipboard.writeText(letter!.text);
    toast.success("Copied to clipboard");
  }

  function download() {
    const blob = new Blob([letter!.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dispute_letter_${letter!.disputeId.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={letter !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="flex flex-row items-center justify-between">
          <DialogTitle>Dispute Letter</DialogTitle>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </DialogHeader>
        <div className="space-y-3">
          <pre
            className="whitespace-pre-wrap text-xs leading-snug bg-secondary/40 p-3 rounded max-h-[60vh] overflow-y-auto"
            data-testid="letter-text"
          >
            {letter.text}
          </pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={copy}>
              Copy
            </Button>
            <Button onClick={download}>
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function readCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((r) => r.startsWith("ghw_csrf_token="));
  return match ? decodeURIComponent(match.split("=")[1] ?? "") : null;
}
