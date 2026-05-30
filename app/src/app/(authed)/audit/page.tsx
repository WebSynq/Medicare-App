"use client";

import * as React from "react";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Download,
  FileText,
  Inbox,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { audit as auditApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { AuditRow } from "@/lib/api/audit";

const COMPLIANCE_ROLES = ["admin", "owner", "compliance"];

export default function AuditPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role);

  const allowed =
    status === "authed" && role != null && COMPLIANCE_ROLES.includes(role);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <AuditConsole />;
}

function AuditConsole() {
  const [eventType, setEventType] = React.useState("");
  const [actorEmail, setActorEmail] = React.useState("");
  const [targetType, setTargetType] = React.useState("");
  const [limit, setLimit] = React.useState(200);

  const listQuery = useQuery({
    queryKey: ["audit", "list", { eventType, actorEmail, targetType, limit }],
    queryFn: () =>
      auditApi.listAudit({
        ...(eventType ? { event_type: eventType } : {}),
        ...(actorEmail ? { actor_email: actorEmail } : {}),
        ...(targetType ? { target_type: targetType } : {}),
        limit,
      }),
  });

  const summaryQuery = useQuery({
    queryKey: ["audit", "summary"],
    queryFn: () => auditApi.getAuditSummary(),
  });

  const exportUrl = auditApi.auditExportUrl({
    format: "csv",
    ...(eventType ? { event_type: eventType } : {}),
    limit: 10000,
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground mt-1">
            HIPAA 7-year retention. Every state-changing event is captured.
          </p>
        </div>
        <Button asChild variant="outline">
          <a href={exportUrl} download>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export CSV
          </a>
        </Button>
      </header>

      <Card>
        <CardContent className="p-4 md:p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            {summaryQuery.data
              ? `${summaryQuery.data.total.toLocaleString()} total audit events on file`
              : "Loading total…"}
          </div>
          {summaryQuery.data ? (
            <div className="flex flex-wrap gap-1.5">
              {summaryQuery.data.by_event_type.slice(0, 12).map((e) => (
                <button
                  key={e.event_type}
                  onClick={() => setEventType(e.event_type)}
                  className={cn(
                    "px-2 py-1 rounded-md text-[10px] border transition-colors",
                    e.event_type === eventType
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-secondary/60",
                  )}
                >
                  {e.event_type}
                  <span className="ml-1.5 opacity-70 tabular-nums">
                    {e.count.toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 md:p-4 flex flex-wrap items-center gap-2">
          <FilterField label="Event type">
            <Input
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="e.g. login_success"
              className="h-9"
            />
          </FilterField>
          <FilterField label="Actor email">
            <Input
              value={actorEmail}
              onChange={(e) => setActorEmail(e.target.value)}
              placeholder="email@…"
              className="h-9"
            />
          </FilterField>
          <FilterField label="Target type">
            <Input
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              placeholder="e.g. lead"
              className="h-9"
            />
          </FilterField>
          <FilterField label="Limit">
            <Select
              value={String(limit)}
              onValueChange={(v) => setLimit(Number(v))}
            >
              <SelectTrigger className="h-9 w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
                <SelectItem value="500">500</SelectItem>
                <SelectItem value="1000">1000</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
          {eventType || actorEmail || targetType ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEventType("");
                setActorEmail("");
                setTargetType("");
              }}
              className="text-xs h-9 self-end"
            >
              Clear
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {listQuery.isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center text-destructive">
            <AlertCircle className="h-8 w-8 mx-auto mb-2" />
            Couldn&apos;t load.
          </CardContent>
        </Card>
      ) : (listQuery.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">No matching events.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/40">
              <tr className="border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Event</th>
                <th className="text-left px-3 py-2">Actor</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">
                  Target
                </th>
                <th className="text-left px-3 py-2 hidden sm:table-cell">IP</th>
                <th className="text-right px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {(listQuery.data ?? []).map((row, i) => (
                <AuditRowView key={i} row={row} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 flex-1 min-w-[140px]">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest">
        {label}
      </Label>
      {children}
    </div>
  );
}

function AuditRowView({ row }: { row: AuditRow }) {
  const [open, setOpen] = React.useState(false);
  return (
    <tr className="border-b border-border/60 hover:bg-secondary/40">
      <td className="px-3 py-2 tabular-nums whitespace-nowrap">
        {new Date(row.timestamp).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline" className="text-[10px]">
          {row.event_type}
        </Badge>
      </td>
      <td className="px-3 py-2 truncate max-w-[200px]">
        {row.actor_email ?? row.actor_id ?? "—"}
      </td>
      <td className="px-3 py-2 hidden md:table-cell truncate max-w-[180px]">
        {row.target_type ? (
          <>
            <span className="text-muted-foreground">{row.target_type}</span>
            {row.target_id ? (
              <>
                {" / "}
                <code className="font-mono">{row.target_id}</code>
              </>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2 hidden sm:table-cell font-mono">
        {row.ip_address ?? "—"}
      </td>
      <td className="px-3 py-2 text-right">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 text-[10px]">
              <Search className="h-3 w-3 mr-1" />
              {row.metadata ? "Details" : "—"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-96 text-xs">
            <pre className="overflow-auto max-h-72 whitespace-pre-wrap break-all">
{JSON.stringify(row, null, 2)}
            </pre>
          </PopoverContent>
        </Popover>
      </td>
    </tr>
  );
}

