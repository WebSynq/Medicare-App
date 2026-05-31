"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clipboard,
  ClipboardCheck,
  Loader2,
  Send,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { isApiError, soa as soaApi } from "@/lib/api";
import type { SoaRecord, SoaStatus } from "@/types";

const STATUS_TINT: Record<SoaStatus, string> = {
  pending: "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30",
  signed: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  expired: "bg-muted text-muted-foreground ring-border",
  revoked: "bg-destructive/15 text-destructive ring-destructive/30",
};

export function SoaTab({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ["soa", leadId],
    queryFn: () => soaApi.listByLead(leadId),
  });

  const sendMutation = useMutation({
    mutationFn: () => soaApi.sendSoa(leadId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["soa", leadId] });
      toast.success("New SOA created — share the link with the client.");
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't create SOA.";
      toast.error(msg);
    },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full rounded" />
        <Skeleton className="h-24 w-full rounded" />
      </div>
    );
  }

  const records = query.data?.records ?? [];
  const current = records[0] ?? null;
  const history = records.slice(1);

  async function copyLink(rec: SoaRecord) {
    try {
      await navigator.clipboard.writeText(rec.public_link);
      setCopiedId(rec.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error("Clipboard blocked.");
    }
  }

  return (
    <div className="space-y-4">
      {current ? (
        <CurrentSoaCard
          record={current}
          copied={copiedId === current.id}
          onCopy={() => copyLink(current)}
        />
      ) : (
        <NoSoaCard onSend={() => sendMutation.mutate()} sending={sendMutation.isPending} />
      )}

      <Card className="border-border/70">
        <CardContent className="p-4 md:p-5 flex flex-wrap items-center gap-2 justify-between">
          <p className="text-xs text-muted-foreground">
            Create a fresh SOA — the previous one stays in the history below.
          </p>
          <Button
            size="sm"
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending}
          >
            {sendMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1.5" />
            )}
            Send New SOA
          </Button>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card className="border-border/70">
          <CardContent className="p-4 md:p-5">
            <h3 className="text-sm font-semibold mb-3">History</h3>
            <ol className="space-y-2">
              {history.map((rec) => (
                <SoaHistoryRow key={rec.id} record={rec} />
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CurrentSoaCard({
  record,
  copied,
  onCopy,
}: {
  record: SoaRecord;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <Card className="border-primary/30 ring-1 ring-primary/15">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold">Current SOA</h3>
          </div>
          <StatusBadge status={record.status} />
        </div>

        {record.status === "signed" ? (
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Field label="Signed name" value={record.signed_name ?? "—"} />
            <Field
              label="Signed at"
              value={
                record.signed_at
                  ? new Date(record.signed_at).toLocaleString()
                  : "—"
              }
            />
            <Field label="IP" value={record.signed_ip ?? "—"} />
            <Field
              label="Products"
              value={(record.products ?? []).join(", ") || "—"}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md bg-secondary/40 p-3">
              <p className="text-[11px] text-muted-foreground mb-1">
                Public link (expires{" "}
                {new Date(record.expires_at).toLocaleDateString()})
              </p>
              <p className="text-xs font-mono break-all">
                {record.public_link}
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={onCopy}
                className="text-xs"
              >
                {copied ? (
                  <ClipboardCheck className="h-3 w-3 mr-1 text-ghw-forest" />
                ) : (
                  <Clipboard className="h-3 w-3 mr-1" />
                )}
                {copied ? "Link copied" : "Copy link"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NoSoaCard({
  onSend,
  sending,
}: {
  onSend: () => void;
  sending: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-10 text-center space-y-3">
        <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto" />
        <div>
          <p className="font-medium text-sm">No SOA on file</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Send a Scope of Appointment to lock in what you&apos;re
            allowed to discuss. The client signs once via a public link.
          </p>
        </div>
        <Button size="sm" onClick={onSend} disabled={sending}>
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5 mr-1.5" />
          )}
          Send SOA
        </Button>
      </CardContent>
    </Card>
  );
}

function SoaHistoryRow({ record }: { record: SoaRecord }) {
  return (
    <li className="text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={record.status} />
          {record.signed_name ? (
            <span className="font-medium truncate">{record.signed_name}</span>
          ) : (
            <span className="text-muted-foreground">
              Created {new Date(record.created_at).toLocaleDateString()}
            </span>
          )}
        </div>
        <span className="text-muted-foreground tabular-nums">
          {new Date(record.created_at).toLocaleDateString()}
        </span>
      </div>
      <Separator className="mt-2" />
    </li>
  );
}

function StatusBadge({ status }: { status: SoaStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] uppercase tracking-wider ring-1 capitalize",
        STATUS_TINT[status],
      )}
    >
      {status}
    </Badge>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{value}</div>
    </div>
  );
}

