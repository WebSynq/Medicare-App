"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  Power,
  PowerOff,
  Trash2,
  UserPlus,
  Users,
  UsersRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { agents as agentsApi, isApiError } from "@/lib/api";
import type {
  AgentRosterRow,
  TeamMember,
} from "@/lib/api/agents";
import {
  useAuthStore,
  selectHasAgencyScope,
  selectIsSuperAdmin,
} from "@/stores/auth";
import { useImpersonationStore } from "@/stores";
import type { UserRole } from "@/types";

const ADMIN_ROLES = new Set<UserRole>(["admin", "owner"]);

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  owner: "Owner",
  agent: "Agent",
  compliance: "Compliance",
  va: "Virtual Assistant",
  support: "Customer Support",
  crm_specialist: "CRM Specialist",
  cyber_security: "Cyber Security",
  sales_manager: "Sales Manager",
  onboarding: "Onboarding Specialist",
  coach: "Coach",
  client_success: "Client Success",
  accounting: "Accounting",
};

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-primary/15 text-primary border-primary/30",
  owner: "bg-primary/15 text-primary border-primary/30",
  agent: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  compliance: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  sales_manager: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
  coach: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
};

function roleLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  return ROLE_LABELS[raw] ?? raw;
}

function formatRevenue(n: number | null | undefined): string {
  const v = Number(n || 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function AgentsPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const allowed = status === "authed" && (hasAgencyScope || isSuperAdmin);

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

  return <AgentsBody />;
}

function AgentsBody() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const setSelectedAgent = useImpersonationStore((s) => s.setAgent);
  const myId = currentUser?.id ?? null;
  const isAdmin = ADMIN_ROLES.has((currentUser?.role ?? "") as UserRole);

  const query = useQuery({
    queryKey: ["agents", "roster"],
    queryFn: agentsApi.list,
  });

  React.useEffect(() => {
    if (query.error) {
      toast.error(
        isApiError(query.error)
          ? query.error.message
          : "Failed to load agents",
      );
    }
  }, [query.error]);

  const agents = React.useMemo(
    () => query.data?.agents ?? [],
    [query.data],
  );

  const stats = React.useMemo(() => {
    const total = agents.length;
    const active = agents.filter(
      (a) => a.is_active && a.status !== "pending",
    ).length;
    const inactive = agents.filter((a) => !a.is_active).length;
    const pending = agents.filter((a) => a.status === "pending").length;
    return { total, active, inactive, pending };
  }, [agents]);

  const [expandedTeamId, setExpandedTeamId] = React.useState<string | null>(
    null,
  );
  const [teamCache, setTeamCache] = React.useState<
    Record<string, TeamMember[]>
  >({});
  const [teamLoadingId, setTeamLoadingId] = React.useState<string | null>(null);

  const [assignSheetAgent, setAssignSheetAgent] =
    React.useState<AgentRosterRow | null>(null);

  const [statusConfirm, setStatusConfirm] = React.useState<{
    agent: AgentRosterRow;
    next: boolean;
  } | null>(null);
  const [pendingStatusId, setPendingStatusId] = React.useState<string | null>(
    null,
  );

  async function loadTeam(agentId: string) {
    setTeamLoadingId(agentId);
    try {
      const res = await agentsApi.getTeam(agentId);
      setTeamCache((m) => ({ ...m, [agentId]: res.members }));
    } catch (err) {
      toast.error(
        isApiError(err) ? err.message : "Failed to load team members",
      );
    } finally {
      setTeamLoadingId(null);
    }
  }

  function toggleExpand(agent: AgentRosterRow) {
    if (expandedTeamId === agent.id) {
      setExpandedTeamId(null);
      return;
    }
    setExpandedTeamId(agent.id);
    if (!teamCache[agent.id]) loadTeam(agent.id);
  }

  const assignMutation = useMutation({
    mutationFn: (vars: { agentId: string; userId: string }) =>
      agentsApi.assignTeam(vars.agentId, vars.userId),
    onSuccess: (_data, vars) => {
      toast.success("Team member assigned");
      setAssignSheetAgent(null);
      // Patch local state; refresh both roster and the expanded team.
      queryClient.invalidateQueries({ queryKey: ["agents", "roster"] });
      setTeamCache((m) => {
        const next = { ...m };
        delete next[vars.agentId];
        return next;
      });
      if (expandedTeamId === vars.agentId) loadTeam(vars.agentId);
    },
    onError: (err) => {
      toast.error(
        isApiError(err) ? err.message : "Could not assign team member",
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: (vars: { agentId: string; userId: string }) =>
      agentsApi.removeTeam(vars.agentId, vars.userId),
    onSuccess: (_data, vars) => {
      toast.success("Removed");
      queryClient.invalidateQueries({ queryKey: ["agents", "roster"] });
      setTeamCache((m) => ({
        ...m,
        [vars.agentId]: (m[vars.agentId] ?? []).filter(
          (x) => x.id !== vars.userId,
        ),
      }));
    },
    onError: (err) => {
      toast.error(
        isApiError(err) ? err.message : "Could not remove team member",
      );
    },
  });

  async function toggleStatus(agent: AgentRosterRow, next: boolean) {
    setPendingStatusId(agent.id);
    try {
      await agentsApi.updateStatus(agent.id, next);
      queryClient.setQueryData(
        ["agents", "roster"],
        (prev: { agents: AgentRosterRow[]; count: number } | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            agents: prev.agents.map((a) =>
              a.id === agent.id ? { ...a, is_active: next } : a,
            ),
          };
        },
      );
      toast.success(
        next
          ? `${agent.full_name || agent.email} reactivated`
          : `${agent.full_name || agent.email} deactivated`,
      );
    } catch (err) {
      toast.error(
        isApiError(err) ? err.message : "Failed to update status",
      );
    } finally {
      setPendingStatusId(null);
      setStatusConfirm(null);
    }
  }

  function handleViewWorkspace(agent: AgentRosterRow) {
    setSelectedAgent({
      id: agent.id,
      name: agent.full_name || agent.email || "Agent",
      email: agent.email ?? null,
    });
    toast.success(`Viewing as ${agent.full_name || agent.email}`);
    router.push("/dashboard");
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      <header>
        <div className="flex items-center gap-2 mb-1">
          <Users className="h-4 w-4 text-primary" />
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Workspace
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight font-display">
          Team Management
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Roster, production roll-up, and access management for every team
          member — agents, admins, compliance, coaches.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Team Members" value={stats.total} icon={Users} />
        <StatTile
          label="Active"
          value={stats.active}
          icon={CheckCircle2}
          tone="forest"
        />
        <StatTile
          label="Inactive"
          value={stats.inactive}
          icon={XCircle}
          tone="destructive"
        />
        <StatTile
          label="Pending"
          value={stats.pending}
          icon={Clock}
          tone="copper"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold">Roster</h3>
            <Badge variant="outline" className="text-xs">
              {query.isLoading ? "…" : agents.length}
            </Badge>
          </div>
          {query.isLoading ? (
            <div className="px-5 pb-5 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-10">
              No agents on file.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Policies</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead>Last Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => {
                    const isSelf = agent.id === myId;
                    const isActive = agent.is_active !== false;
                    const isPending = agent.status === "pending";
                    const isBusy = pendingStatusId === agent.id;
                    const teamCount = agent.team_count || 0;
                    const isExpanded = expandedTeamId === agent.id;
                    const teamMembers = teamCache[agent.id];
                    const teamLoading = teamLoadingId === agent.id;
                    const canHaveTeam = agent.role === "agent";
                    return (
                      <React.Fragment key={agent.id}>
                        <TableRow
                          className={cn(
                            "hover:bg-secondary/40",
                            isSelf && "opacity-60",
                          )}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <span className="text-sm">
                                {agent.full_name ||
                                  agent.agent_name ||
                                  agent.email ||
                                  "—"}
                              </span>
                              {teamCount > 0 && (
                                <Badge
                                  variant="outline"
                                  className="bg-chart-4/15 text-chart-4 border-chart-4/30 text-[10px]"
                                >
                                  <UsersRound className="h-2.5 w-2.5 mr-1" />
                                  {teamCount} team
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {agent.email}
                            </div>
                            <Badge
                              variant="outline"
                              className={cn(
                                "mt-1 text-[10px]",
                                ROLE_BADGE[agent.role ?? ""] ??
                                  "bg-secondary text-foreground/80",
                              )}
                            >
                              {roleLabel(agent.role)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {isPending ? (
                              <Badge
                                variant="outline"
                                className="bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
                              >
                                Pending
                              </Badge>
                            ) : isActive ? (
                              <Badge
                                variant="outline"
                                className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                              >
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="outline">Inactive</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {agent.lead_count ?? 0}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {agent.policy_count ?? 0}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatRevenue(agent.production_revenue)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(agent.last_submission_date)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                              {isAdmin && canHaveTeam && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleExpand(agent)}
                                  className="h-7 text-xs text-chart-4 hover:bg-chart-4/10"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5 mr-1" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5 mr-1" />
                                  )}
                                  Team
                                </Button>
                              )}
                              {isAdmin && canHaveTeam && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setAssignSheetAgent(agent)}
                                  className="h-7 text-xs"
                                >
                                  <UserPlus className="h-3.5 w-3.5 mr-1" />
                                  Assign
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleViewWorkspace(agent)}
                                disabled={isSelf}
                                className="h-7 text-xs"
                              >
                                <Eye className="h-3.5 w-3.5 mr-1" />
                                View
                              </Button>
                              {isAdmin && isActive && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setStatusConfirm({ agent, next: false })
                                  }
                                  disabled={isSelf || isBusy}
                                  className="h-7 text-xs text-destructive hover:bg-destructive/10"
                                >
                                  <PowerOff className="h-3.5 w-3.5 mr-1" />
                                  Deactivate
                                </Button>
                              )}
                              {isAdmin && !isActive && (
                                <Button
                                  size="sm"
                                  onClick={() => toggleStatus(agent, true)}
                                  disabled={isSelf || isBusy}
                                  className="h-7 text-xs bg-ghw-forest hover:bg-ghw-forest/90 text-white"
                                >
                                  <Power className="h-3.5 w-3.5 mr-1" />
                                  Reactivate
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-secondary/30 hover:bg-secondary/30">
                            <TableCell colSpan={7} className="py-3">
                              <div className="pl-4 border-l-2 border-chart-4/30">
                                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                                  Team members
                                </div>
                                {teamLoading ? (
                                  <p className="text-xs text-muted-foreground">
                                    Loading…
                                  </p>
                                ) : (teamMembers ?? []).length === 0 ? (
                                  <p className="text-xs text-muted-foreground">
                                    No team members assigned yet.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {(teamMembers ?? []).map((m) => (
                                      <div
                                        key={m.id}
                                        className="flex items-center justify-between gap-3 text-sm py-1.5"
                                      >
                                        <div className="min-w-0">
                                          <div className="font-medium truncate">
                                            {m.full_name ||
                                              m.agent_name ||
                                              m.email}
                                          </div>
                                          <div className="text-[11px] text-muted-foreground truncate">
                                            {m.email} · {roleLabel(m.role)}
                                          </div>
                                        </div>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() =>
                                            removeMutation.mutate({
                                              agentId: agent.id,
                                              userId: m.id,
                                            })
                                          }
                                          disabled={removeMutation.isPending}
                                          className="h-8 text-xs text-destructive hover:bg-destructive/10 flex-shrink-0"
                                        >
                                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                                          Remove
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AssignTeamSheet
        parentAgent={assignSheetAgent}
        allAgents={agents}
        onClose={() => setAssignSheetAgent(null)}
        onAssign={(agentId, userId) =>
          assignMutation.mutate({ agentId, userId })
        }
        busy={assignMutation.isPending}
      />

      <AlertDialog
        open={!!statusConfirm}
        onOpenChange={(open) => {
          if (!open) setStatusConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate{" "}
              {statusConfirm?.agent.full_name ||
                statusConfirm?.agent.email}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will lose portal access immediately. Their data and
              audit trail are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                statusConfirm &&
                toggleStatus(statusConfirm.agent, statusConfirm.next)
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "forest" | "destructive" | "copper";
}) {
  const toneClasses =
    tone === "forest"
      ? "text-ghw-forest"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "copper"
          ? "text-ghw-copper"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
          <Icon className={cn("h-4 w-4", toneClasses)} />
        </div>
        <div className={cn("text-3xl font-bold tabular-nums", toneClasses)}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function AssignTeamSheet({
  parentAgent,
  allAgents,
  onClose,
  onAssign,
  busy,
}: {
  parentAgent: AgentRosterRow | null;
  allAgents: AgentRosterRow[];
  onClose: () => void;
  onAssign: (parentId: string, userId: string) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = React.useState("");

  React.useEffect(() => {
    setSelected("");
  }, [parentAgent?.id]);

  const candidates = React.useMemo(() => {
    if (!parentAgent) return [];
    return allAgents.filter(
      (a) =>
        a.id !== parentAgent.id &&
        (a.role === "va" || a.role === "agent") &&
        a.is_active !== false,
    );
  }, [parentAgent, allAgents]);

  return (
    <Sheet
      open={!!parentAgent}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
      >
        <SheetHeader className="mb-4">
          <SheetTitle>Assign Team Member</SheetTitle>
          <SheetDescription>
            Pick a VA or agent to assign to{" "}
            <strong>
              {parentAgent?.full_name || parentAgent?.email}
            </strong>
            &rsquo;s account. They&rsquo;ll work inside that scope from
            their next sign-in.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Team member
            </label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger>
                <SelectValue placeholder="Select a user…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                    No eligible users.
                  </div>
                ) : (
                  candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {(c.full_name || c.email) +
                        " — " +
                        (c.role === "va" ? "Virtual Assistant" : "Agent")}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-[10px] mt-1.5 text-muted-foreground">
              Only VAs and agents may be assigned. Other roles operate at
              agency scope.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!selected || !parentAgent || busy}
              onClick={() => parentAgent && onAssign(parentAgent.id, selected)}
            >
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              Assign
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
