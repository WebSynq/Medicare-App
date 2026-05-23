import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users,
  UsersRound,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  Power,
  PowerOff,
  ChevronDown,
  ChevronRight,
  UserPlus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, auth } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";
import ScrollableCard from "@/components/ScrollableCard";

// Maps raw role strings to human labels for the team table.
const ROLE_LABELS = {
  admin: "Administrator",
  agent: "Agent",
  compliance: "Compliance",
  va: "Virtual Assistant",
  support: "Customer Support",
  crm_specialist: "CRM Specialist",
  cyber_security: "Cyber Security",
  sales_manager: "Sales Manager",
  onboarding: "Onboarding Specialist",
  coach: "Coach",
  director: "Director",
};

// Role badge palette — one tone per role so the team table is easier
// to scan at a glance.
const ROLE_BADGE = {
  admin: "bg-[#e85d2f] text-white",
  agent: "bg-blue-100 text-blue-900",
  compliance: "bg-purple-100 text-purple-900",
  sales_manager: "bg-teal-100 text-teal-900",
  coach: "bg-emerald-100 text-emerald-900",
  director: "bg-amber-100 text-amber-900",
};

function roleLabel(raw) {
  if (!raw) return "—";
  return ROLE_LABELS[raw] || raw;
}

function RoleBadge({ role }) {
  const cls = ROLE_BADGE[role] || "bg-secondary text-foreground/80";
  return (
    <Badge
      className={`rounded-full border-0 ${cls}`}
      data-testid={`role-badge-${role || "unknown"}`}
    >
      {roleLabel(role)}
    </Badge>
  );
}

function StatCard({ label, value, icon: Icon, tone = "default" }) {
  const toneClasses = {
    default: "text-foreground",
    success: "text-emerald-700",
    danger: "text-rose-700",
    warn: "text-amber-700",
  }[tone];
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className={`w-4 h-4 ${toneClasses}`} />}
        </div>
        <div
          className={`text-3xl font-bold mt-2 tabular-nums ${toneClasses}`}
          style={{ fontFamily: "Outfit" }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function formatRevenue(n) {
  const v = Number(n || 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function AgentManagement() {
  const currentUser = auth.getUser();
  const role = currentUser?.role;
  const myId = currentUser?.id;
  const isAdmin = role === "admin" || role === "owner";

  const navigate = useNavigate();
  const { setSelectedAgent } = useAgent();

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState(null);
  // expandedTeamId: id of the agent whose team-member sub-row is open.
  // teamMembersById: cache of fetched team rosters so re-expanding the
  // same agent doesn't re-fire the network. Invalidated on assign /
  // remove via deleting the entry before refetch.
  const [expandedTeamId, setExpandedTeamId] = useState(null);
  const [teamMembersById, setTeamMembersById] = useState({});
  const [teamLoadingId, setTeamLoadingId] = useState(null);
  const [assignSheetAgent, setAssignSheetAgent] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/agents");
      setAgents(res?.data?.agents || []);
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Failed to load agents",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const stats = useMemo(() => {
    const total = agents.length;
    const active = agents.filter((a) => a.is_active && a.status !== "pending").length;
    const inactive = agents.filter((a) => !a.is_active).length;
    const pending = agents.filter((a) => a.status === "pending").length;
    return { total, active, inactive, pending };
  }, [agents]);

  function handleViewWorkspace(agent) {
    setSelectedAgent(agent);
    toast.success(`Viewing as ${agent.full_name || agent.email}`);
    navigate("/dashboard");
  }

  async function loadTeam(agentId) {
    setTeamLoadingId(agentId);
    try {
      const res = await api.get(`/agents/${agentId}/team`);
      setTeamMembersById((m) => ({ ...m, [agentId]: res.data?.members || [] }));
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Failed to load team members",
      );
    } finally {
      setTeamLoadingId(null);
    }
  }

  function toggleExpandTeam(agent) {
    if (expandedTeamId === agent.id) {
      setExpandedTeamId(null);
      return;
    }
    setExpandedTeamId(agent.id);
    if (!teamMembersById[agent.id]) loadTeam(agent.id);
  }

  async function handleAssignTeamMember(parentAgent, userId) {
    try {
      await api.post(`/agents/${parentAgent.id}/team`, { user_id: userId });
      toast.success("Team member assigned");
      setAssignSheetAgent(null);
      // Bump the agent's team_count locally + refresh the team roster
      // for this agent so the expanded list updates immediately.
      setAgents((prev) =>
        prev.map((a) =>
          a.id === parentAgent.id
            ? { ...a, team_count: (a.team_count || 0) + 1 }
            : a,
        ),
      );
      // Invalidate then refetch so the expanded section reflects the
      // new member if it's currently open.
      setTeamMembersById((m) => {
        const next = { ...m };
        delete next[parentAgent.id];
        return next;
      });
      if (expandedTeamId === parentAgent.id) loadTeam(parentAgent.id);
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Could not assign team member",
      );
    }
  }

  async function handleRemoveTeamMember(parentAgent, member) {
    const name = member.full_name || member.email;
    if (!window.confirm(
      `Remove ${name} from ${parentAgent.full_name || parentAgent.email}'s team? ` +
      "They will revert to their own account scope.",
    )) return;
    try {
      await api.delete(`/agents/${parentAgent.id}/team/${member.id}`);
      toast.success(`${name} removed`);
      setAgents((prev) =>
        prev.map((a) =>
          a.id === parentAgent.id
            ? { ...a, team_count: Math.max(0, (a.team_count || 0) - 1) }
            : a,
        ),
      );
      setTeamMembersById((m) => ({
        ...m,
        [parentAgent.id]: (m[parentAgent.id] || []).filter(
          (x) => x.id !== member.id,
        ),
      }));
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Could not remove team member",
      );
    }
  }

  async function handleToggleStatus(agent) {
    if (!isAdmin) return;
    if (agent.id === myId) {
      toast.error("You can't change your own active status.");
      return;
    }
    const next = !agent.is_active;
    const name = agent.full_name || agent.email;
    // Deactivation is destructive in the audit-log sense (the user
    // loses portal access until a second admin reactivates). Confirm
    // explicitly; reactivation has no such side effect so it's a
    // one-click action.
    if (!next) {
      const ok = window.confirm(
        `Deactivate ${name}? They will lose portal access immediately. ` +
        "Their data will be preserved.",
      );
      if (!ok) return;
    }
    setPendingId(agent.id);
    try {
      await api.patch(`/agents/${agent.id}/status`, { is_active: next });
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, is_active: next } : a)),
      );
      toast.success(next ? `${name} reactivated` : `${name} deactivated`);
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Failed to update status",
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Users className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Workspace
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Team Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Roster, production roll-up, and access management for every
            team member — agents, admins, compliance, coaches.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Team Members" value={stats.total} icon={Users} />
          <StatCard
            label="Active"
            value={stats.active}
            icon={CheckCircle2}
            tone="success"
          />
          <StatCard
            label="Inactive"
            value={stats.inactive}
            icon={XCircle}
            tone="danger"
          />
          <StatCard
            label="Pending"
            value={stats.pending}
            icon={Clock}
            tone="warn"
          />
        </div>

        <ScrollableCard
          title="Roster"
          count={agents.length}
          height="calc(100vh - 320px)"
          loading={loading}
          isEmpty={!loading && agents.length === 0}
          emptyState="No agents on file."
          testId="agent-management-card"
        >
          <div className="overflow-x-auto w-full">
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
                {agents.map((a) => {
                    const isSelf = a.id === myId;
                    const isActive = a.is_active !== false;
                    const isPending = a.status === "pending";
                    const isBusy = pendingId === a.id;
                    const teamCount = a.team_count || 0;
                    const isExpanded = expandedTeamId === a.id;
                    const teamMembers = teamMembersById[a.id];
                    const teamLoading = teamLoadingId === a.id;
                    const canHaveTeam = a.role === "agent";
                    return (
                      <React.Fragment key={a.id}>
                      <TableRow
                        className={`hover:bg-secondary/40 ${
                          isSelf ? "opacity-60" : ""
                        }`}
                        data-testid={`agent-row-${a.id}`}
                      >
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <span>{a.full_name || a.agent_name || "—"}</span>
                            {teamCount > 0 && (
                              <Badge
                                className="rounded-full bg-blue-100 text-blue-900 border-0 text-[10px]"
                                data-testid={`agent-team-badge-${a.id}`}
                              >
                                <UsersRound className="w-2.5 h-2.5 mr-1" />
                                {teamCount} team
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {a.email}
                          </div>
                          <div className="mt-1">
                            <RoleBadge role={a.role} />
                          </div>
                        </TableCell>
                        <TableCell>
                          {isPending ? (
                            <Badge className="rounded-full bg-amber-100 text-amber-900">
                              Pending
                            </Badge>
                          ) : isActive ? (
                            <Badge className="rounded-full bg-emerald-100 text-emerald-900">
                              Active
                            </Badge>
                          ) : (
                            <Badge className="rounded-full bg-gray-200 text-gray-700">
                              Inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.lead_count ?? 0}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.policy_count ?? 0}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatRevenue(a.production_revenue)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(a.last_submission_date)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-2 flex-wrap justify-end">
                            {isAdmin && canHaveTeam && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleExpandTeam(a)}
                                className="text-blue-700 hover:text-blue-800 hover:bg-blue-50"
                                data-testid={`agent-team-toggle-${a.id}`}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 mr-1.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 mr-1.5" />
                                )}
                                Team
                              </Button>
                            )}
                            {isAdmin && canHaveTeam && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setAssignSheetAgent(a)}
                                data-testid={`agent-assign-team-${a.id}`}
                              >
                                <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                                Assign
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewWorkspace(a)}
                              disabled={isSelf}
                              data-testid={`agent-view-workspace-${a.id}`}
                            >
                              <Eye className="w-3.5 h-3.5 mr-1.5" />
                              View Workspace
                            </Button>
                            {isAdmin && isActive && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleToggleStatus(a)}
                                disabled={isSelf || isBusy}
                                title={
                                  isSelf
                                    ? "Cannot modify your own account"
                                    : undefined
                                }
                                className="text-rose-700 hover:text-rose-800 hover:bg-rose-50"
                                data-testid={`agent-toggle-${a.id}`}
                              >
                                <PowerOff className="w-3.5 h-3.5 mr-1.5" />
                                Deactivate
                              </Button>
                            )}
                            {isAdmin && !isActive && (
                              <Button
                                size="sm"
                                onClick={() => handleToggleStatus(a)}
                                disabled={isSelf || isBusy}
                                title={
                                  isSelf
                                    ? "Cannot modify your own account"
                                    : undefined
                                }
                                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                data-testid={`agent-toggle-${a.id}`}
                              >
                                <Power className="w-3.5 h-3.5 mr-1.5" />
                                Reactivate
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow
                          className="bg-secondary/30 hover:bg-secondary/30"
                          data-testid={`agent-team-expanded-${a.id}`}
                        >
                          <TableCell colSpan={7} className="py-3">
                            <div className="pl-4 border-l-2 border-blue-200">
                              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
                                Team members
                              </div>
                              {teamLoading ? (
                                <p className="text-sm text-muted-foreground">
                                  Loading…
                                </p>
                              ) : (teamMembers || []).length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                  No team members assigned yet.
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  {teamMembers.map((m) => (
                                    <div
                                      key={m.id}
                                      className="flex items-center justify-between gap-3 text-sm py-1.5"
                                      data-testid={`team-member-${m.id}`}
                                    >
                                      <div className="min-w-0">
                                        <div className="font-medium truncate">
                                          {m.full_name || m.agent_name || m.email}
                                        </div>
                                        <div className="text-[11px] text-muted-foreground truncate">
                                          {m.email} · {roleLabel(m.role)}
                                        </div>
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          handleRemoveTeamMember(a, m)
                                        }
                                        className="text-rose-700 hover:text-rose-800 hover:bg-rose-50 h-8 flex-shrink-0"
                                        data-testid={`team-member-remove-${m.id}`}
                                      >
                                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
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
        </ScrollableCard>
      </main>

      <AssignTeamMemberSheet
        parentAgent={assignSheetAgent}
        allAgents={agents}
        onClose={() => setAssignSheetAgent(null)}
        onAssign={handleAssignTeamMember}
      />
    </div>
  );
}

// ── Assign team member sheet ─────────────────────────────────────────────
// Lists every user with role ∈ (va, agent) who isn't already on
// SOMEONE's team. Single-pick + confirm. Disabled when the candidate
// list is empty so the admin knows there's no one to assign right now
// rather than getting a silently-broken button.
function AssignTeamMemberSheet({ parentAgent, allAgents, onClose, onAssign }) {
  const [selected, setSelected] = useState("");

  useEffect(() => {
    setSelected("");
  }, [parentAgent?.id]);

  const candidates = useMemo(() => {
    if (!parentAgent) return [];
    return (allAgents || []).filter(
      (a) =>
        a.id !== parentAgent.id &&
        (a.role === "va" || a.role === "agent") &&
        a.is_active !== false &&
        // Already-assigned VAs / agents would 409 from the backend.
        // We don't fetch parent_agent_id on the list endpoint today,
        // so an in-flight 409 is the safety net.
        true,
    );
  }, [parentAgent, allAgents]);

  const open = !!parentAgent;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
      >
        <SheetHeader className="mb-4">
          <SheetTitle>Assign Team Member</SheetTitle>
          <SheetDescription>
            Pick a VA or agent to assign to{" "}
            <strong>{parentAgent?.full_name || parentAgent?.email}</strong>'s
            account. They'll work inside that scope from their next
            sign-in.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5 uppercase tracking-[0.08em] text-muted-foreground">
              Team member
            </label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger data-testid="assign-team-select">
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
            <p className="text-[11px] mt-1.5 text-muted-foreground">
              Only VAs and agents may be assigned. Other roles
              operate at agency scope.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-[#e85d2f] hover:bg-[#c84416] text-white"
              disabled={!selected || !parentAgent}
              onClick={() => onAssign(parentAgent, selected)}
              data-testid="assign-team-confirm"
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Assign to {parentAgent?.full_name?.split(" ")[0] || "agent"}'s
              account
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
