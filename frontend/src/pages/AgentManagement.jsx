import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  Power,
  PowerOff,
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
import { api, auth } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";

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
  const isAdmin = role === "admin";

  const navigate = useNavigate();
  const { setSelectedAgent } = useAgent();

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState(null);

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

  async function handleToggleStatus(agent) {
    if (!isAdmin) return;
    if (agent.id === myId) {
      toast.error("You can't change your own active status.");
      return;
    }
    const next = !agent.is_active;
    setPendingId(agent.id);
    try {
      await api.patch(`/agents/${agent.id}/status`, { is_active: next });
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, is_active: next } : a)),
      );
      toast.success(
        next
          ? `${agent.full_name || agent.email} activated`
          : `${agent.full_name || agent.email} deactivated`,
      );
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Failed to update agent status",
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
            Agents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Roster, production roll-up, and access management.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total Agents" value={stats.total} icon={Users} />
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

        <Card className="bg-surface">
          <CardContent className="p-5">
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
                  {loading && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center py-10 text-muted-foreground"
                      >
                        Loading agents…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading && agents.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center py-10 text-muted-foreground"
                      >
                        No agents on file.
                      </TableCell>
                    </TableRow>
                  )}
                  {agents.map((a) => {
                    const isSelf = a.id === myId;
                    const isActive = a.is_active !== false;
                    const isPending = a.status === "pending";
                    const isBusy = pendingId === a.id;
                    return (
                      <TableRow
                        key={a.id}
                        className={`hover:bg-secondary/40 ${
                          isSelf ? "opacity-60" : ""
                        }`}
                        data-testid={`agent-row-${a.id}`}
                      >
                        <TableCell className="font-medium">
                          <div>{a.full_name || a.agent_name || "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {a.email}
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
                          <div className="inline-flex items-center gap-2">
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
                            {isAdmin && (
                              <Button
                                variant={isActive ? "outline" : "default"}
                                size="sm"
                                onClick={() => handleToggleStatus(a)}
                                disabled={isSelf || isBusy}
                                data-testid={`agent-toggle-${a.id}`}
                              >
                                {isActive ? (
                                  <>
                                    <PowerOff className="w-3.5 h-3.5 mr-1.5" />
                                    Deactivate
                                  </>
                                ) : (
                                  <>
                                    <Power className="w-3.5 h-3.5 mr-1.5" />
                                    Activate
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
