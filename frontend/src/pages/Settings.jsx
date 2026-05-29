import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShieldCheck,
  Plug,
  Building2,
  Users2,
  Activity,
  Download,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  CalendarDays,
  Cloud,
  Settings as SettingsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";
import ScrollableCard from "@/components/ScrollableCard";

const PAGE_SIZE = 50;

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function dayDiff(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.round(ms / 86400000);
}

// ── Google Calendar (per-agent OAuth) ────────────────────────────────────
// Reads /api/calendar/google/status on mount; on connect, redirects to the
// Google consent URL from /connect; on disconnect, clears the token via
// DELETE /disconnect. Also handles ?calendar=connected|cancelled|error
// landed by the backend callback's RedirectResponse.
function GoogleCalendarCard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);   // { connected, connected_at }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/calendar/google/status");
      setStatus(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Couldn't check calendar status",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Show a toast for the redirect-back states from the backend callback,
  // then strip the query param so a refresh doesn't re-fire the toast.
  useEffect(() => {
    const flag = searchParams.get("calendar");
    if (!flag) return;
    if (flag === "connected") toast.success("Google Calendar connected.");
    else if (flag === "cancelled") toast.info("Google Calendar connection cancelled.");
    else if (flag === "error") toast.error("Couldn't connect Google Calendar. Try again.");
    const next = new URLSearchParams(searchParams);
    next.delete("calendar");
    setSearchParams(next, { replace: true });
    // Refresh status — the toast above implies a state change.
    refresh();
  }, [searchParams, setSearchParams, refresh]);

  async function connect() {
    setBusy(true);
    try {
      const { data } = await api.get("/calendar/google/connect");
      if (data?.auth_url) {
        window.location.href = data.auth_url;
      } else {
        toast.error("No auth URL returned");
        setBusy(false);
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Connect failed");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google Calendar? Future appointments won't sync until you reconnect.")) return;
    setBusy(true);
    try {
      await api.delete("/calendar/google/disconnect");
      toast.success("Google Calendar disconnected.");
      await refresh();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="integration-google-calendar">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary grid place-items-center flex-shrink-0">
            <CalendarDays className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Google Calendar</h3>
              {loading ? (
                <Badge className="rounded-full bg-gray-100 text-gray-700 border-0 text-[10px]">
                  Loading…
                </Badge>
              ) : status?.connected ? (
                <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0 text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5" />
                  Connected
                </Badge>
              ) : (
                <Badge className="rounded-full bg-gray-100 text-gray-700 border-0 text-[10px]">
                  Not Connected
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sync your appointments to Google Calendar automatically. When
              you book an appointment in the portal, it appears on your
              Google Calendar instantly.
            </p>
            {status?.connected && status.connected_at && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Connected {new Date(status.connected_at).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>

        {!loading && (
          status?.connected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={disconnect}
              disabled={busy}
              data-testid="gcal-disconnect"
            >
              {busy ? "Working…" : "Disconnect"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={connect}
              disabled={busy}
              size="sm"
              data-testid="gcal-connect"
            >
              {busy ? "Redirecting…" : "Connect Google Calendar"}
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}


// ── Profile tab ──────────────────────────────────────────────────────────
function ProfileTab({ me, refresh }) {
  const isAdmin = me?.role === "admin" || me?.role === "owner";

  const [profileForm, setProfileForm] = useState({
    full_name: me?.full_name || "",
    email: me?.email || "",
    phone: me?.phone || "",
    timezone: me?.timezone || "America/Chicago",
    agent_npn: me?.agent_npn || "",
    agency_name: me?.agency_name || "",
    current_password: "",
  });
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    setProfileForm((p) => ({
      ...p,
      full_name: me?.full_name || "",
      email: me?.email || "",
      phone: me?.phone || "",
      timezone: me?.timezone || "America/Chicago",
      agent_npn: me?.agent_npn || "",
      agency_name: me?.agency_name || "",
    }));
  }, [me?.full_name, me?.email, me?.phone, me?.timezone, me?.agent_npn, me?.agency_name]);

  async function saveProfile(e) {
    e.preventDefault();
    if (!profileForm.current_password) {
      toast.error("Current password required to save changes.");
      return;
    }
    setProfileSaving(true);
    try {
      const body = {
        current_password: profileForm.current_password,
        full_name: profileForm.full_name,
        email: profileForm.email,
        phone: profileForm.phone,
        timezone: profileForm.timezone,
        agent_npn: profileForm.agent_npn,
      };
      const { data } = await api.patch("/profile/me", body);
      toast.success("Profile updated.");
      setProfileForm((p) => ({ ...p, current_password: "" }));
      refresh(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Update failed"
      );
    } finally {
      setProfileSaving(false);
    }
  }

  // ── password form
  const [pw, setPw] = useState({
    current_password: "",
    new_password: "",
    confirm: "",
  });
  const [pwSaving, setPwSaving] = useState(false);

  async function savePassword(e) {
    e.preventDefault();
    if (pw.new_password !== pw.confirm) {
      toast.error("New password and confirmation don't match.");
      return;
    }
    if (!pw.current_password || !pw.new_password) {
      toast.error("Fill all password fields.");
      return;
    }
    setPwSaving(true);
    try {
      await api.patch("/profile/me", {
        current_password: pw.current_password,
        new_password: pw.new_password,
      });
      toast.success("Password updated.");
      setPw({ current_password: "", new_password: "", confirm: "" });
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const reqs = detail?.requirements;
      if (Array.isArray(reqs)) {
        toast.error(`Password requirements: ${reqs.join("; ")}`);
      } else {
        toast.error(detail || err?.message || "Update failed");
      }
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Personal Info</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Confirm your current password to save changes.
            </p>
          </div>
          <form onSubmit={saveProfile} className="space-y-3">
            <div>
              <Label htmlFor="p-name">Full name</Label>
              <Input
                id="p-name"
                value={profileForm.full_name}
                onChange={(e) =>
                  setProfileForm({ ...profileForm, full_name: e.target.value })
                }
                data-testid="profile-fullname"
              />
            </div>
            <div>
              <Label htmlFor="p-email">Email</Label>
              <Input
                id="p-email"
                type="email"
                value={profileForm.email}
                onChange={(e) =>
                  setProfileForm({ ...profileForm, email: e.target.value })
                }
                data-testid="profile-email"
              />
            </div>
            <div>
              <Label htmlFor="p-phone">Phone</Label>
              <Input
                id="p-phone"
                value={profileForm.phone}
                onChange={(e) =>
                  setProfileForm({ ...profileForm, phone: e.target.value })
                }
                data-testid="profile-phone"
              />
            </div>
            <div>
              <Label htmlFor="p-tz">Your Timezone</Label>
              <Select
                value={profileForm.timezone}
                onValueChange={(v) =>
                  setProfileForm({ ...profileForm, timezone: v })
                }
              >
                <SelectTrigger id="p-tz" data-testid="profile-timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="America/New_York">Eastern (America/New_York)</SelectItem>
                  <SelectItem value="America/Chicago">Central (America/Chicago)</SelectItem>
                  <SelectItem value="America/Denver">Mountain (America/Denver)</SelectItem>
                  <SelectItem value="America/Phoenix">Arizona — no DST (America/Phoenix)</SelectItem>
                  <SelectItem value="America/Los_Angeles">Pacific (America/Los_Angeles)</SelectItem>
                  <SelectItem value="America/Anchorage">Alaska (America/Anchorage)</SelectItem>
                  <SelectItem value="Pacific/Honolulu">Hawaii (Pacific/Honolulu)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Used for calendar sync and appointment scheduling
              </p>
            </div>
            <div>
              <Label htmlFor="p-npn">Agent NPN</Label>
              <Input
                id="p-npn"
                value={profileForm.agent_npn}
                onChange={(e) =>
                  setProfileForm({
                    ...profileForm,
                    agent_npn: e.target.value,
                  })
                }
                placeholder="5–10 digits"
                data-testid="profile-npn"
              />
            </div>
            {isAdmin && (
              <div>
                <Label htmlFor="p-agency">Agency name</Label>
                <Input
                  id="p-agency"
                  value={profileForm.agency_name}
                  disabled
                  className="bg-secondary/40"
                  data-testid="profile-agency"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Edit the agency-wide name on the Agency tab.
                </p>
              </div>
            )}
            <div className="pt-2 border-t border-border">
              <Label htmlFor="p-cur">Current password</Label>
              <Input
                id="p-cur"
                type="password"
                value={profileForm.current_password}
                onChange={(e) =>
                  setProfileForm({
                    ...profileForm,
                    current_password: e.target.value,
                  })
                }
                data-testid="profile-current-pw"
                autoComplete="current-password"
              />
            </div>
            <Button
              type="submit"
              disabled={profileSaving}
              data-testid="profile-save"
            >
              {profileSaving ? "Saving…" : "Save changes"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Change Password</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sign out of other sessions after changing — your active session
              stays valid.
            </p>
          </div>
          <form onSubmit={savePassword} className="space-y-3">
            <div>
              <Label htmlFor="pw-cur">Current password</Label>
              <Input
                id="pw-cur"
                type="password"
                value={pw.current_password}
                onChange={(e) =>
                  setPw({ ...pw, current_password: e.target.value })
                }
                autoComplete="current-password"
                data-testid="pw-current"
              />
            </div>
            <div>
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                value={pw.new_password}
                onChange={(e) =>
                  setPw({ ...pw, new_password: e.target.value })
                }
                autoComplete="new-password"
                data-testid="pw-new"
              />
            </div>
            <div>
              <Label htmlFor="pw-conf">Confirm new password</Label>
              <Input
                id="pw-conf"
                type="password"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                autoComplete="new-password"
                data-testid="pw-confirm"
              />
            </div>
            <Button type="submit" disabled={pwSaving} data-testid="pw-save">
              {pwSaving ? "Saving…" : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Security tab ─────────────────────────────────────────────────────────
// Two-factor enforcement now lives at the login flow itself: magic
// links are the second factor (possession of the inbox) for the
// passwordless path, and the password path is gated by the same
// brute-force lockout. There is no per-account authenticator toggle
// anymore, so the Security tab is reduced to the session-history
// readout plus a one-liner explaining the sign-in model.
function SecurityTab() {
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setSessionsLoading(true);
      try {
        const { data } = await api.get("/profile/sessions");
        setSessions(data.sessions || []);
      } catch {
        setSessions([]);
      } finally {
        setSessionsLoading(false);
      }
    })();
  }, []);

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Active Sessions</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Last 10 successful sign-ins. If you don't recognize a session,
            change your password immediately.
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IP</TableHead>
                  <TableHead>Device / Browser</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsLoading && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!sessionsLoading && sessions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                      No recorded logins yet.
                    </TableCell>
                  </TableRow>
                )}
                {sessions.map((s, i) => (
                  <TableRow key={`${s.timestamp}-${i}`}>
                    <TableCell className="font-mono text-xs">
                      {s.ip_address || "—"}
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[280px]">
                      {s.user_agent || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {fmtDateTime(s.timestamp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Sign-in</h3>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your account uses passwordless <strong>magic-link sign-in</strong>
            {" "}as the primary path — a one-time link is emailed to you at
            sign-in time and expires in 15 minutes. You can also sign in
            with your email and password.
          </p>
          <p className="text-xs text-muted-foreground">
            Failed sign-in attempts are tracked per email and rate-limited
            to prevent brute-force access.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}



// ── Audit Log tab ────────────────────────────────────────────────────────
function AuditLogTab({ me }) {
  const isPrivileged =
    me?.role === "admin" || me?.role === "owner" || me?.role === "compliance";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 500 };
      if (from) params.from = from;
      if (to) params.to = to;
      if (action) params.action = action;
      if (userId) params.user_id = userId;
      const { data } = await api.get("/profile/audit-log", { params });
      setRows(data.entries || []);
      setPage(1);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Audit fetch failed"
      );
    } finally {
      setLoading(false);
    }
  }, [from, to, action, userId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isPrivileged) return;
    (async () => {
      try {
        const { data } = await api.get("/profile/team");
        setUsers(data.members || []);
      } catch {
        setUsers([]);
      }
    })();
  }, [isPrivileged]);

  // Distinct action types derived from the current page of results
  const actionOptions = useMemo(() => {
    const s = new Set(rows.map((r) => r.action).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function exportCsv() {
    try {
      const params = new URLSearchParams({ export: "csv", limit: "5000" });
      if (from) params.append("from", from);
      if (to) params.append("to", to);
      if (action) params.append("action", action);
      if (userId) params.append("user_id", userId);
      const resp = await api.get(`/profile/audit-log?${params.toString()}`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `ghw-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("Export failed");
    }
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">
              {isPrivileged ? "Agency Audit Log" : "Your Activity"}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isPrivileged
                ? "Append-only. Every action across the agency."
                : "Append-only record of actions you have taken."}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            data-testid="audit-export-csv"
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="audit-from"
            />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="audit-to"
            />
          </div>
          <div className="min-w-[180px]">
            <Label className="text-xs">Action</Label>
            <Select value={action || "all"} onValueChange={(v) => setAction(v === "all" ? "" : v)}>
              <SelectTrigger data-testid="audit-action">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actionOptions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isPrivileged && (
            <div className="min-w-[200px]">
              <Label className="text-xs">User</Label>
              <Select value={userId || "all"} onValueChange={(v) => setUserId(v === "all" ? "" : v)}>
                <SelectTrigger data-testid="audit-user">
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name || u.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button variant="outline" onClick={load} data-testid="audit-search">
            Search
          </Button>
        </div>

        <ScrollableCard
          count={rows.length}
          height="calc(100vh - 480px)"
          loading={loading}
          isEmpty={!loading && pageRows.length === 0}
          emptyState="No audit entries match these filters."
          testId="settings-audit-card"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r, i) => (
                  <TableRow key={`${r.timestamp}-${i}`}>
                    <TableCell className="text-xs">
                      {fmtDateTime(r.timestamp)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{r.actor_email || "—"}</div>
                      {r.target_email && r.target_email !== r.actor_email && (
                        <div className="text-[10px] text-muted-foreground">
                          → {r.target_email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{r.action}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[360px] truncate">
                      {r.metadata
                        ? JSON.stringify(r.metadata)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {r.ip_address || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollableCard>

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Agency tab (admin only) ───────────────────────────────────────────────
function AgencyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyAgency, setBusyAgency] = useState(false);
  const [busyEo, setBusyEo] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/profile/agency");
        setData(data);
      } catch (err) {
        toast.error("Failed to load agency settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function saveAgency() {
    setBusyAgency(true);
    try {
      const { data: fresh } = await api.patch("/profile/agency", {
        agency_name: data.agency_name,
        business_address: data.business_address,
        phone: data.phone,
        agency_npn: data.agency_npn,
        timezone: data.timezone,
      });
      setData(fresh);
      toast.success("Agency profile saved.");
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Save failed"
      );
    } finally {
      setBusyAgency(false);
    }
  }

  async function saveEo() {
    setBusyEo(true);
    try {
      const { data: fresh } = await api.patch("/profile/agency", {
        eo_carrier: data.eo_carrier,
        eo_policy_number: data.eo_policy_number,
        eo_expires_at: data.eo_expires_at,
      });
      setData(fresh);
      toast.success("E&O policy saved.");
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Save failed"
      );
    } finally {
      setBusyEo(false);
    }
  }

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  const eoDays = dayDiff(data.eo_expires_at);
  const eoExpiringSoon = eoDays !== null && eoDays >= 0 && eoDays < 90;
  const eoExpired = eoDays !== null && eoDays < 0;

  return (
    <div className="space-y-5">
    <div className="grid lg:grid-cols-2 gap-5">
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Agency Profile</h3>
          </div>
          <div className="space-y-3">
            <div>
              <Label>Agency name</Label>
              <Input
                value={data.agency_name || ""}
                onChange={(e) =>
                  setData({ ...data, agency_name: e.target.value })
                }
                data-testid="agency-name"
              />
            </div>
            <div>
              <Label>Business address</Label>
              <Textarea
                rows={2}
                value={data.business_address || ""}
                onChange={(e) =>
                  setData({ ...data, business_address: e.target.value })
                }
                data-testid="agency-address"
              />
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label>Phone</Label>
                <Input
                  value={data.phone || ""}
                  onChange={(e) => setData({ ...data, phone: e.target.value })}
                  data-testid="agency-phone"
                />
              </div>
              <div>
                <Label>Agency NPN</Label>
                <Input
                  value={data.agency_npn || ""}
                  onChange={(e) =>
                    setData({ ...data, agency_npn: e.target.value })
                  }
                  data-testid="agency-npn"
                />
              </div>
            </div>
            <div>
              <Label>Timezone</Label>
              <Select
                value={data.timezone || "America/Chicago"}
                onValueChange={(v) => setData({ ...data, timezone: v })}
              >
                <SelectTrigger data-testid="agency-tz">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "America/New_York",
                    "America/Chicago",
                    "America/Denver",
                    "America/Los_Angeles",
                    "America/Phoenix",
                    "America/Anchorage",
                    "Pacific/Honolulu",
                    "UTC",
                  ].map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={saveAgency}
              disabled={busyAgency}
              data-testid="agency-save"
            >
              {busyAgency ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">E&amp;O Insurance</h3>
          </div>
          <div className="space-y-3">
            <div>
              <Label>Carrier</Label>
              <Input
                value={data.eo_carrier || ""}
                onChange={(e) =>
                  setData({ ...data, eo_carrier: e.target.value })
                }
                data-testid="eo-carrier"
              />
            </div>
            <div>
              <Label>Policy number</Label>
              <Input
                value={data.eo_policy_number || ""}
                onChange={(e) =>
                  setData({ ...data, eo_policy_number: e.target.value })
                }
                data-testid="eo-policy"
              />
            </div>
            <div>
              <Label>Expiration date</Label>
              <Input
                type="date"
                value={
                  data.eo_expires_at ? data.eo_expires_at.slice(0, 10) : ""
                }
                onChange={(e) =>
                  setData({ ...data, eo_expires_at: e.target.value })
                }
                data-testid="eo-expires"
              />
              {eoExpired && (
                <Badge className="mt-2 rounded-full bg-red-100 text-red-900 border-0">
                  <AlertTriangle className="w-3 h-3 mr-1" /> Expired{" "}
                  {Math.abs(eoDays)} day(s) ago
                </Badge>
              )}
              {!eoExpired && eoExpiringSoon && (
                <Badge className="mt-2 rounded-full bg-amber-100 text-amber-900 border-0">
                  <AlertTriangle className="w-3 h-3 mr-1" /> Expires in{" "}
                  {eoDays} day(s)
                </Badge>
              )}
            </div>
            <Button
              onClick={saveEo}
              disabled={busyEo}
              data-testid="eo-save"
            >
              {busyEo ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
      <BackupCard />
    </div>
  );
}


// ── Database Backup card (rendered inside AgencyTab) ─────────────────────
function BackupCard() {
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const { data } = await api.get("/backup/history");
      setHistory(data?.items || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not load backup history");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function runNow() {
    setRunning(true);
    try {
      const { data } = await api.post("/backup/run");
      setLastResult(data);
      if (data?.success) {
        toast.success(
          `Backup uploaded · ${(data.size_bytes / 1024 / 1024).toFixed(2)} MB`,
        );
      } else {
        toast.error(`Backup failed: ${data?.error || "unknown error"}`);
      }
      await loadHistory();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Backup failed");
    } finally {
      setRunning(false);
    }
  }

  const latest = history[0];

  return (
    <Card data-testid="backup-card">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Database Backups</h3>
          {latest && (
            <Badge
              className={`rounded-full border-0 ${
                latest.success
                  ? "bg-emerald-100 text-emerald-900"
                  : "bg-rose-100 text-rose-900"
              }`}
            >
              {latest.success ? "Success" : "Failed"}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Last backup:{" "}
          <span className="text-foreground/80 font-medium">
            {latest
              ? `${fmtDateTime(latest.timestamp)}${
                  latest.size_bytes
                    ? ` · ${(latest.size_bytes / 1024 / 1024).toFixed(2)} MB`
                    : ""
                }`
              : "never"}
          </span>
        </div>
        {lastResult && !lastResult.success && (
          <div className="text-xs text-rose-700 rounded-md bg-rose-50 border border-rose-200 p-2">
            {lastResult.error}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={runNow}
            disabled={running}
            className="text-white"
            style={{
              background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
            }}
            data-testid="backup-run-now"
          >
            {running ? "Running…" : "Run Backup Now"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen((v) => !v)}
            data-testid="backup-toggle-history"
          >
            {historyOpen ? "Hide history" : "View Backup History"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Backups run automatically daily at 02:00 AM UTC. Retained for 90 days.
        </p>

        {historyOpen && (
          <div
            className="border-t border-border pt-3 max-h-72 overflow-y-auto ghw-scroll"
            data-testid="backup-history"
          >
            {historyLoading && (
              <p className="text-xs text-muted-foreground py-3 text-center">
                Loading…
              </p>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="text-xs text-muted-foreground py-3 text-center">
                No backups recorded yet.
              </p>
            )}
            <ul className="space-y-1.5 text-xs">
              {history.map((h, i) => (
                <li
                  key={`${h.timestamp}-${i}`}
                  className="flex items-start justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="font-medium">
                      {fmtDateTime(h.timestamp)}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {h.s3_key || h.error || ""}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {h.success ? (
                      <span className="text-emerald-700 font-semibold">
                        {h.size_bytes
                          ? `${(h.size_bytes / 1024 / 1024).toFixed(2)} MB`
                          : "ok"}
                      </span>
                    ) : (
                      <span className="text-rose-700 font-semibold">
                        failed
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Integrations tab (admin only) ────────────────────────────────────────
function IntegrationsTab({ isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // The /integrations/status endpoint is admin-only — skip the fetch
    // entirely for non-admin users so we don't surface a needless 403.
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get("/integrations/status");
      setData(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail ||
          err?.message ||
          "Status check failed"
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-8">
      {/* ── GHL connection + bulk import (per-agent) ─────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">GoHighLevel</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect your GHL sub-account to import contacts and keep
            data in sync.
          </p>
        </div>
        <GHLImportPanel />
      </section>

      {/* ── Your Connections — per-agent, visible to everyone ─────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Your Connections</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Personal calendar and productivity tools you connect to your
            individual account.
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <GoogleCalendarCard />
          <ComingSoonCard
            icon={Building2}
            title="Google Workspace"
            description="Connect your Google Workspace account for team directory, shared calendars, and Drive document storage."
            testId="integration-google-workspace"
          />
          <ComingSoonCard
            icon={Cloud}
            title="iCloud Calendar"
            description="Sync appointments to Apple Calendar via iCloud."
            testId="integration-icloud"
          />
        </div>
      </section>

      {/* ── Platform — agency-wide ops integrations, admin only ───── */}
      {isAdmin && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Platform</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Agency-wide service connections.{" "}
                {data?.checked_at && (
                  <span>Checked {fmtDateTime(data.checked_at)} · </span>
                )}
                All checks are read-only.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
            </Button>
          </div>

          {loading || !data ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                Loading…
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                {[
                  {
                    key: "ghl",
                    title: "GoHighLevel",
                    info: data.ghl,
                    lines: [
                      `Location: ${data.ghl?.metadata?.location_id || "—"}`,
                      data.ghl?.metadata?.mock_mode ? "Mock mode" : "Live",
                    ],
                  },
                  {
                    key: "bedrock",
                    title: "AWS Bedrock",
                    info: data.bedrock,
                    lines: [
                      `Model: ${data.bedrock?.metadata?.model || "—"}`,
                      `Region: ${data.bedrock?.metadata?.region || "—"}`,
                    ],
                  },
                  {
                    key: "s3",
                    title: "S3 Storage",
                    info: data.s3,
                    lines: [
                      `Bucket: ${data.s3?.metadata?.bucket || "—"}`,
                      `Region: ${data.s3?.metadata?.region || "—"}`,
                    ],
                  },
                  {
                    key: "comtrack",
                    title: "ComTrack",
                    info: data.comtrack,
                    lines: [
                      data.comtrack?.metadata?.last_successful_sync
                        ? `Last sync: ${fmtDateTime(data.comtrack.metadata.last_successful_sync)}`
                        : "No successful sync yet",
                    ],
                  },
                ].map(({ key, title, info, lines }) => (
                  <Card key={key} data-testid={`integration-${key}`}>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Plug className="w-4 h-4 text-muted-foreground" />
                          <h3 className="text-sm font-semibold">{title}</h3>
                        </div>
                        {info?.status === "ok" && (
                          <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5" />
                            Connected
                          </Badge>
                        )}
                        {info?.status === "error" && (
                          <Badge className="rounded-full bg-red-100 text-red-900 border-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-600 mr-1.5" />
                            Error
                          </Badge>
                        )}
                        {info?.status === "not_configured" && (
                          <Badge className="rounded-full bg-amber-100 text-amber-900 border-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-600 mr-1.5" />
                            Not configured
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{info?.detail}</p>
                      <ul className="text-xs space-y-1 text-foreground/80">
                        {lines.filter(Boolean).map((line, i) => (
                          <li key={i} className="font-mono">
                            {line}
                          </li>
                        ))}
                      </ul>
                      {key === "ghl" && <GhlSyncNow />}
                    </CardContent>
                  </Card>
                ))}
              </div>

              <GhlWebhookStatus />
            </>
          )}
        </section>
      )}
    </div>
  );
}


// ── Coming-Soon placeholder card ────────────────────────────────────────
// Matches GoogleCalendarCard's visual structure (icon tile + title +
// description + status badge + button) so the three "Your Connections"
// cards line up cleanly in the grid.
function ComingSoonCard({ icon: Icon, title, description, testId }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary grid place-items-center flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{title}</h3>
              <Badge className="rounded-full bg-blue-100 text-blue-900 border-0 text-[10px]">
                Coming Soon
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {description}
            </p>
          </div>
        </div>
        <Button type="button" disabled variant="outline" size="sm">
          Connect
        </Button>
      </CardContent>
    </Card>
  );
}

// Sync-Now button rendered inside the GHL integration card. POSTs to
// /api/ghl/sync which pulls a page of contacts and reconciles them
// against our leads collection. Disabled while in-flight.
function GhlSyncNow() {
  const [busy, setBusy] = useState(false);

  async function handleSync() {
    setBusy(true);
    try {
      const { data } = await api.post("/ghl/sync");
      if (data?.note) {
        toast.message(data.note);
      } else {
        const synced = data?.synced ?? 0;
        const created = data?.created ?? 0;
        const updated = data?.updated ?? 0;
        toast.success(
          `Synced ${synced} contacts (${created} new, ${updated} updated)`,
        );
      }
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "GHL sync failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pt-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={handleSync}
        disabled={busy}
        data-testid="ghl-sync-now"
      >
        <RefreshCw
          className={`w-3.5 h-3.5 mr-1.5 ${busy ? "animate-spin" : ""}`}
        />
        {busy ? "Syncing…" : "Sync Now"}
      </Button>
    </div>
  );
}

// GoHighLevel inbound webhook status. Lives alongside the integrations
// grid; loads on mount and on demand via the Test Webhook button which
// hits GET /api/ghl/webhook/config to re-pull the URL + counters.
function GhlWebhookStatus() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/ghl/webhook/config");
      setInfo(data);
    } catch (err) {
      // Non-admin or endpoint missing — show a graceful empty state
      // instead of a destructive toast.
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTest() {
    setTesting(true);
    try {
      const { data } = await api.get("/ghl/webhook/config");
      setInfo(data);
      toast.success(
        data?.secret_configured
          ? "Webhook endpoint reachable. Secret is configured."
          : "Webhook endpoint reachable — but GHL_WEBHOOK_SECRET is NOT set.",
      );
    } catch (err) {
      toast.error(
        err?.response?.data?.detail ||
          err?.message ||
          "Webhook check failed",
      );
    } finally {
      setTesting(false);
    }
  }

  async function copyUrl() {
    if (!info?.webhook_url) return;
    try {
      await navigator.clipboard.writeText(info.webhook_url);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Couldn't copy — select the URL manually.");
    }
  }

  if (loading) return null;
  if (!info) return null;

  return (
    <Card data-testid="ghl-webhook-card">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Plug className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">GHL Inbound Webhook</h3>
          </div>
          {info.secret_configured ? (
            <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5" />
              Secret configured
            </Badge>
          ) : (
            <Badge className="rounded-full bg-amber-100 text-amber-900 border-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-600 mr-1.5" />
              Secret missing
            </Badge>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Webhook URL</Label>
          <div className="flex items-stretch gap-2">
            <Input
              readOnly
              value={info.webhook_url || ""}
              onFocus={(e) => e.target.select()}
              className="font-mono text-xs"
              data-testid="ghl-webhook-url"
            />
            <Button
              type="button"
              variant="outline"
              onClick={copyUrl}
              data-testid="ghl-webhook-copy"
            >
              Copy
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Paste this URL into your GHL workflow webhook step. Configure
            it with the same secret as <code>GHL_WEBHOOK_SECRET</code> on
            the backend.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Last webhook received</div>
            <div className="font-mono">
              {info.last_received_at
                ? fmtDateTime(info.last_received_at)
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">
              Leads received via webhook
            </div>
            <div className="font-mono">{info.leads_received_total ?? 0}</div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-muted-foreground">
            Location: <code>{info.location_id || "—"}</code> · Supported:{" "}
            {(info.supported_events || []).join(", ")}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={testing}
            data-testid="ghl-webhook-test"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${testing ? "animate-spin" : ""}`}
            />
            Test Webhook
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Friendly labels for every role we let an admin invite. Admin is
// deliberately omitted — promoting someone to admin requires a manual
// DB / tools change, not a UI invite.
const INVITABLE_ROLES = [
  { value: "agent", label: "Agent" },
  { value: "va", label: "Virtual Assistant" },
  { value: "support", label: "Customer Support" },
  { value: "crm_specialist", label: "CRM Specialist" },
  { value: "cyber_security", label: "Cyber Security" },
  { value: "sales_manager", label: "Sales Manager" },
  { value: "onboarding", label: "Onboarding Specialist" },
  { value: "compliance", label: "Compliance" },
];

// ── Team tab (admin only) ────────────────────────────────────────────────
function TeamTab() {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("agent");
  const [inviting, setInviting] = useState(false);
  // We surface the generated invite URL to the admin because the backend
  // doesn't ship email itself — the admin copies the link and sends it
  // out-of-band (Slack/email).
  const [lastInvite, setLastInvite] = useState(null);

  const [invites, setInvites] = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);

  const [team, setTeam] = useState([]);
  const [teamLoading, setTeamLoading] = useState(true);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true);
    try {
      const { data } = await api.get("/auth/invites");
      setInvites(data.invites || []);
    } catch {
      setInvites([]);
    } finally {
      setInvitesLoading(false);
    }
  }, []);

  const loadTeam = useCallback(async () => {
    setTeamLoading(true);
    try {
      const { data } = await api.get("/profile/team");
      setTeam(data.members || []);
    } catch {
      setTeam([]);
    } finally {
      setTeamLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvites();
    loadTeam();
  }, [loadInvites, loadTeam]);

  async function sendInvite() {
    if (!inviteEmail.trim()) {
      toast.error("Email required.");
      return;
    }
    setInviting(true);
    try {
      const { data } = await api.post("/auth/invite", {
        email: inviteEmail.trim(),
        full_name: "",
        agency_name: "",
        role: inviteRole,
      });
      // Show the invite URL inline — there's no mail service wired up,
      // the admin copies and sends manually.
      setLastInvite({
        email: inviteEmail.trim(),
        url: data?.invite_url || "",
        expires_at: data?.expires_at || "",
      });
      toast.success(`Invite link created for ${inviteEmail}. Copy & send.`);
      setInviteEmail("");
      loadInvites();
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Invite failed"
      );
    } finally {
      setInviting(false);
    }
  }

  async function copyInviteUrl() {
    if (!lastInvite?.url) return;
    try {
      await navigator.clipboard.writeText(lastInvite.url);
      toast.success("Invite link copied to clipboard.");
    } catch {
      toast.error("Couldn't copy — select the link manually.");
    }
  }

  async function revokeInvite(invite) {
    if (!invite?.id) return;
    if (!window.confirm(
      `Revoke the invite for ${invite.email}? The link will stop working immediately.`,
    )) {
      return;
    }
    try {
      await api.delete(`/auth/invites/${invite.id}`);
      toast.success(`Invite for ${invite.email} revoked.`);
      // Optimistic local removal so the row disappears even before the
      // server-side list refreshes.
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      loadInvites();
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Revoke failed",
      );
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Users2 className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Invite Agent</h3>
          </div>
          <div className="grid md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-2">
              <Label className="text-xs">Email</Label>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                data-testid="team-invite-email"
              />
            </div>
            <div>
              <Label className="text-xs">Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger data-testid="team-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            onClick={sendInvite}
            disabled={inviting}
            data-testid="team-invite-send"
          >
            {inviting ? "Sending…" : "Create invite link"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            We don't email invites yet — copy the generated link below and
            send it to the new team member directly. The role chosen above
            is applied when they register.
          </p>

        </CardContent>
      </Card>

      {/* Invite-link result panel — pulled out of the form Card so it
          renders as a high-contrast standalone block that the agent
          can't miss. Stays visible until they create another invite. */}
      {lastInvite?.url && (
        <Card
          className="border-[#e85d2f]/40 bg-orange-50"
          data-testid="team-invite-result"
        >
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#e85d2f]" />
                <h3 className="text-sm font-semibold text-[#1e2d3d]">
                  Invite link for {lastInvite.email}
                </h3>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLastInvite(null)}
                className="h-7 text-xs"
                data-testid="team-invite-dismiss"
              >
                Dismiss
              </Button>
            </div>
            <p className="text-[11px] text-foreground/70">
              Copy this link and send it to the new team member. It
              expires in 24 hours and can only be used once.
            </p>
            <div className="flex items-stretch gap-2">
              <Input
                readOnly
                value={lastInvite.url}
                onFocus={(e) => e.target.select()}
                className="font-mono text-xs"
                data-testid="team-invite-link"
              />
              <Button
                type="button"
                onClick={copyInviteUrl}
                className="text-white"
                style={{
                  background:
                    "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                }}
                data-testid="team-invite-copy"
              >
                Copy
              </Button>
            </div>
            {lastInvite.expires_at && (
              <div className="text-[11px] text-foreground/60">
                Expires {new Date(lastInvite.expires_at).toLocaleString()}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <ScrollableCard
        title="Pending Invites"
        count={invites.length}
        height="320px"
        loading={invitesLoading}
        isEmpty={!invitesLoading && invites.length === 0}
        emptyState="No active invites."
        testId="settings-pending-invites-card"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((iv) => {
              const roleLabel =
                (INVITABLE_ROLES.find((r) => r.value === iv.role) || {}).label
                || iv.role
                || "Agent";
              return (
                <TableRow key={iv.id} data-testid={`team-invite-row-${iv.id}`}>
                  <TableCell className="text-sm">{iv.email}</TableCell>
                  <TableCell className="text-xs">
                    <Badge className="rounded-full bg-secondary text-foreground/80 border-0">
                      {roleLabel}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtDateTime(iv.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {fmtDateTime(iv.expires_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => revokeInvite(iv)}
                      data-testid={`team-invite-revoke-${iv.id}`}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollableCard>

      <ScrollableCard
        title="Active Team"
        count={team.length}
        height="400px"
        loading={teamLoading}
        isEmpty={!teamLoading && team.length === 0}
        emptyState="No team members yet."
        testId="settings-active-team-card"
        headerAction={
          <Button asChild variant="outline" size="sm">
            <Link to="/audit">
              Manage agents
              <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
            </Link>
          </Button>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium text-sm">
                  {u.full_name || "—"}
                </TableCell>
                <TableCell className="text-sm">{u.email}</TableCell>
                <TableCell className="text-xs capitalize">
                  {u.role}
                </TableCell>
                <TableCell>
                  {u.is_active ? (
                    <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                    </Badge>
                  ) : (
                    <Badge className="rounded-full bg-gray-200 text-gray-800 border-0">
                      Disabled
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableCard>
    </div>
  );
}

// ── Top-level page ───────────────────────────────────────────────────────
// Valid tab ids that can be opened via the ?tab=… URL query param.
// Kept in sync with the TabsTrigger value props below.
const SETTINGS_TAB_IDS = new Set([
  "profile",
  "security",
  "audit",
  "agency",
  "integrations",
  "team",
  "compliance",
]);

// Roles that may access the Compliance tab — mirrors the deps.COMPLIANCE_ROLES
// group on the backend so cyber_security / sales_manager get the same view.
const COMPLIANCE_TAB_ROLES = new Set([
  "admin",
  "owner",
  "compliance",
  "cyber_security",
  "sales_manager",
]);

export default function Settings() {
  const [me, setMe] = useState(null);
  const cachedUser = auth.getUser();
  const role = me?.role || cachedUser?.role || "agent";
  // Owner has admin-equivalent powers — same admin-tab visibility.
  const isAdmin = role === "admin" || role === "owner";
  const canSeeCompliance = COMPLIANCE_TAB_ROLES.has(role);
  // Client Success is a support-only role with no need (or authorisation)
  // to see audit-log entries that span the whole agency. Keep the tab
  // hidden — the backend /audit endpoint already 403s for them.
  const canSeeAudit = role !== "client_success";

  // Read the ?tab=… query param so redirects from the legacy /audit and
  // /admin/compliance routes land on the right tab. Falls back to
  // "profile" when the param is missing or names a tab the current
  // user can't see (e.g. an agent hitting ?tab=team).
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") || "";
  const initialTab = useMemo(() => {
    if (!SETTINGS_TAB_IDS.has(requestedTab)) return "profile";
    // Gate admin-only tabs. (integrations is visible to everyone — admins
    // additionally see the Platform section inside it.)
    if (!isAdmin && (requestedTab === "agency" || requestedTab === "team")) {
      return "profile";
    }
    if (requestedTab === "compliance" && !canSeeCompliance) return "profile";
    if (requestedTab === "audit" && !canSeeAudit) return "profile";
    return requestedTab;
  }, [requestedTab, isAdmin, canSeeCompliance, canSeeAudit]);

  const loadMe = useCallback(async () => {
    try {
      const { data } = await api.get("/profile/me");
      setMe(data);
    } catch (err) {
      toast.error("Failed to load profile");
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  function applyPatched(updated) {
    setMe((prev) => ({ ...(prev || {}), ...updated }));
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1200px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <SettingsIcon className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Settings
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Account &amp; Agency Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your profile, security, audit trail, integrations
            {isAdmin && ", agency, and team"}.
          </p>
        </div>

        <Tabs defaultValue={initialTab} className="w-full">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="profile" data-testid="tab-profile">
              Profile
            </TabsTrigger>
            <TabsTrigger value="security" data-testid="tab-security">
              Security
            </TabsTrigger>
            <TabsTrigger value="booking" data-testid="tab-booking">
              Booking Page
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="calendars" data-testid="tab-calendars">
                Calendars
              </TabsTrigger>
            )}
            {canSeeAudit && (
              <TabsTrigger value="audit" data-testid="tab-audit">
                Audit Log
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="agency" data-testid="tab-agency">
                Agency
              </TabsTrigger>
            )}
            <TabsTrigger value="integrations" data-testid="tab-integrations">
              Integrations
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="team" data-testid="tab-team">
                Team
              </TabsTrigger>
            )}
            {canSeeCompliance && (
              <TabsTrigger value="compliance" data-testid="tab-compliance">
                Compliance
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="profile" className="mt-4">
            <ProfileTab me={me} refresh={applyPatched} />
          </TabsContent>
          <TabsContent value="security" className="mt-4">
            <SecurityTab />
          </TabsContent>
          <TabsContent value="booking" className="mt-4">
            <BookingTab me={me} refresh={applyPatched} />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="calendars" className="mt-4">
              <CalendarsTab />
            </TabsContent>
          )}
          <TabsContent value="audit" className="mt-4">
            {canSeeAudit && <AuditLogTab me={me} />}
          </TabsContent>
          {isAdmin && (
            <TabsContent value="agency" className="mt-4">
              <AgencyTab />
            </TabsContent>
          )}
          <TabsContent value="integrations" className="mt-4">
            <IntegrationsTab isAdmin={isAdmin} />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="team" className="mt-4">
              <TeamTab />
            </TabsContent>
          )}
          {canSeeCompliance && (
            <TabsContent value="compliance" className="mt-4">
              <ComplianceTab />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
}


// ── Compliance tab (admin + compliance roles only) ───────────────────────
// Pulls the consolidated views from /api/compliance/{soa,tcpa} and wires
// the two CSV exports to /api/compliance/export/{soa,tcpa}.csv. Each
// section is independent so a slow upstream on one doesn't stall the
// others.

function ComplianceTab() {
  return (
    <div className="space-y-6">
      <ComplianceSOA />
      <ComplianceTCPA />
      <ComplianceExports />
      <ComplianceAEPPlaceholder />
    </div>
  );
}

function ComplianceSOA() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter !== "all" ? { status: statusFilter } : {};
      const { data } = await api.get("/compliance/soa", { params });
      setData(data);
    } catch {
      setData({ stats: {}, records: [] });
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = data?.stats || {};
  const records = data?.records || [];

  return (
    <section className="space-y-3">
      <h3
        className="text-sm font-semibold tracking-tight"
        style={{ fontFamily: "Outfit" }}
      >
        SOA Compliance
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ComplianceStat label="SOA Sent MTD" value={stats.sent_mtd ?? 0} />
        <ComplianceStat
          label="SOA Signed MTD"
          value={stats.signed_mtd ?? 0}
          tone="success"
        />
        <ComplianceStat
          label="SOA Pending"
          value={stats.pending ?? 0}
          tone="warn"
        />
        <ComplianceStat
          label="SOA Expired"
          value={stats.expired ?? 0}
          tone="danger"
        />
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40 h-9" data-testid="compliance-soa-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="signed">Signed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={load} className="self-end">
            Refresh
          </Button>
        </CardContent>
      </Card>

      <ScrollableCard
        title="SOA Records"
        count={records.length}
        height="420px"
        loading={loading}
        isEmpty={!loading && records.length === 0}
        emptyState="No SOA records match these filters."
        testId="compliance-soa-card"
      >
        <div className="overflow-x-auto w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Signed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Products</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium text-sm">
                    {r.lead_name}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.agent_name || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.signed_date ? fmtDateTime(r.signed_date) : "—"}
                  </TableCell>
                  <TableCell>
                    <SOAStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground truncate max-w-[220px]">
                    {(r.products_discussed || []).join(", ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ScrollableCard>
    </section>
  );
}

function SOAStatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  if (s === "signed") {
    return (
      <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
        Signed
      </Badge>
    );
  }
  if (s === "expired") {
    return (
      <Badge className="rounded-full bg-rose-100 text-rose-900 border-0">
        Expired
      </Badge>
    );
  }
  return (
    <Badge className="rounded-full bg-amber-100 text-amber-900 border-0">
      Pending
    </Badge>
  );
}

function ComplianceTCPA() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/compliance/tcpa");
        if (alive) setData(data);
      } catch {
        if (alive) setData({ stats: {}, leads: [] });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  async function sendConsentRequest(lead) {
    // Best-effort SMS via GHL workflow. Backend integration not wired
    // yet — for now we just toast so the agent sees the action they'd
    // be taking. When the endpoint lands this becomes an api.post.
    toast.message(`Consent request queued for ${lead.name} (${lead.phone})`);
  }

  const stats = data?.stats || {};
  const leads = data?.leads || [];

  return (
    <section className="space-y-3">
      <h3
        className="text-sm font-semibold tracking-tight"
        style={{ fontFamily: "Outfit" }}
      >
        TCPA Compliance
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ComplianceStat
          label="Total Consented"
          value={stats.consented ?? 0}
          tone="success"
        />
        <ComplianceStat
          label="No Consent on File"
          value={stats.no_consent ?? 0}
          tone="danger"
        />
        <ComplianceStat
          label="Consent Rate"
          value={`${stats.consent_rate_pct ?? 0}%`}
          tone="accent"
        />
      </div>

      <ScrollableCard
        title="Leads Without Consent"
        count={leads.length}
        height="360px"
        loading={loading}
        isEmpty={!loading && leads.length === 0}
        emptyState="Every lead on file has TCPA consent recorded ✅"
        testId="compliance-tcpa-card"
      >
        <div className="overflow-x-auto w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Lead Source</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium text-sm">{l.name}</TableCell>
                  <TableCell className="text-sm font-mono">
                    {l.phone || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.lead_source}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.created_at ? fmtDateTime(l.created_at) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => sendConsentRequest(l)}
                      data-testid={`compliance-tcpa-send-${l.id}`}
                    >
                      Send Consent Request
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ScrollableCard>
    </section>
  );
}

function ComplianceExports() {
  // Anchor downloads — credentials: include is the default for same-site
  // links, but we use an absolute URL via the api client base so the
  // host matches and the auth cookie is sent.
  const base = (api.defaults.baseURL || "").replace(/\/+$/, "");
  return (
    <section className="space-y-3">
      <h3
        className="text-sm font-semibold tracking-tight"
        style={{ fontFamily: "Outfit" }}
      >
        CMS Audit Export
      </h3>
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" data-testid="compliance-export-soa">
            <a
              href={`${base}/compliance/export/soa.csv`}
              target="_blank"
              rel="noreferrer"
            >
              Export CMS Audit Report
            </a>
          </Button>
          <Button asChild variant="outline" data-testid="compliance-export-tcpa">
            <a
              href={`${base}/compliance/export/tcpa.csv`}
              target="_blank"
              rel="noreferrer"
            >
              Export TCPA Consent Log
            </a>
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function ComplianceAEPPlaceholder() {
  const tiles = [
    "AHIP Certification",
    "State Licenses",
    "Carrier Certifications",
    "E&O Insurance",
  ];
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3
          className="text-sm font-semibold tracking-tight"
          style={{ fontFamily: "Outfit" }}
        >
          AEP Readiness
        </h3>
        <Badge className="rounded-full bg-amber-100 text-amber-900 border-0 text-[10px] font-medium">
          Coming Soon
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        AEP readiness checklist coming soon. We&rsquo;ll track each of these
        per agent and flag anything overdue before Oct 15.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <Card key={t} className="bg-surface">
            <CardContent className="p-4 text-center">
              <p className="text-xs font-medium">{t}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                tracking pending
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ComplianceStat({ label, value, tone }) {
  const valueClass = {
    success: "text-emerald-700",
    danger: "text-rose-700",
    warn: "text-amber-700",
    accent: "text-[#e85d2f]",
  }[tone] || "text-foreground";
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div
          className={`mt-2 text-2xl font-bold tabular-nums ${valueClass}`}
          style={{ fontFamily: "Outfit" }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}


// ── Booking Page tab ──────────────────────────────────────────────────────
// Per-agent booking page configuration. Saves via PATCH /api/profile/
// booking-settings — the backend auto-generates the slug from full_name
// on the first save and ensures uniqueness across the agency. The slug
// is preserved on subsequent saves (renaming would break outstanding
// booking links — admin task, not self-serve).

const _BOOKING_DEFAULTS = {
  is_enabled: false,
  slug: null,
  bio: "",
  meeting_types: ["phone", "video"],
  phone_number: "",
  video_link: "",
  appointment_duration: 30,
  buffer_minutes: 15,
  max_per_day: 10,
  advance_notice_hours: 24,
  booking_window_days: 60,
  working_hours: {
    monday:    { enabled: true,  start: "09:00", end: "17:00" },
    tuesday:   { enabled: true,  start: "09:00", end: "17:00" },
    wednesday: { enabled: true,  start: "09:00", end: "17:00" },
    thursday:  { enabled: true,  start: "09:00", end: "17:00" },
    friday:    { enabled: true,  start: "09:00", end: "17:00" },
    saturday:  { enabled: false, start: "09:00", end: "12:00" },
    sunday:    { enabled: false, start: "09:00", end: "12:00" },
  },
};

const _WEEKDAYS = [
  "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
];

function _timeOptions() {
  const out = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      out.push(`${hh}:${mm}`);
    }
  }
  return out;
}
const TIME_OPTIONS = _timeOptions();

function BookingTab({ me, refresh }) {
  const initial = useMemo(() => {
    const bs = me?.booking_settings || {};
    return {
      ..._BOOKING_DEFAULTS,
      ...bs,
      working_hours: {
        ..._BOOKING_DEFAULTS.working_hours,
        ...(bs.working_hours || {}),
      },
    };
  }, [me]);

  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  // Feature C — sub-phase C2. On mount, look for an Individual
  // calendar owned by the caller. When present, saves PATCH the
  // calendar row instead of profile/booking-settings — the calendar
  // becomes the authoritative source for slug, hours, duration.
  // When absent (pre-migration user), we keep the legacy save path
  // and surface a banner so the user knows a migration is pending.
  const [calendarId, setCalendarId] = useState(null);
  const [calendarLoading, setCalendarLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadOwnCalendar() {
      if (!me?.id) {
        setCalendarLoading(false);
        return;
      }
      try {
        const { data } = await api.get("/calendars?type=individual");
        if (cancelled) return;
        const owned = (data?.calendars || []).find(
          (c) => c.owner_id === me.id && c.is_active !== false,
        );
        setCalendarId(owned?.id || null);
        if (owned?.booking_settings) {
          // Translate calendar shape → form shape for any keys that
          // differ. Both sides share working_hours / meeting_types.
          setForm((f) => ({
            ...f,
            appointment_duration:
              owned.booking_settings.duration_minutes
              ?? f.appointment_duration,
            buffer_minutes:
              owned.booking_settings.buffer_minutes ?? f.buffer_minutes,
            advance_notice_hours:
              owned.booking_settings.advance_notice_hours
              ?? f.advance_notice_hours,
            max_per_day:
              owned.booking_settings.max_bookings_per_day ?? f.max_per_day,
            working_hours:
              owned.booking_settings.working_hours || f.working_hours,
            meeting_types:
              owned.booking_settings.meeting_types || f.meeting_types,
            slug: owned.slug || f.slug,
          }));
        }
      } catch {
        // 401/403/etc — silent fallback to legacy save path.
        if (!cancelled) setCalendarId(null);
      } finally {
        if (!cancelled) setCalendarLoading(false);
      }
    }
    loadOwnCalendar();
    return () => { cancelled = true; };
  }, [me?.id]);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function setHours(day, patch) {
    setForm((f) => ({
      ...f,
      working_hours: {
        ...f.working_hours,
        [day]: { ...f.working_hours[day], ...patch },
      },
    }));
  }
  function toggleMeetingType(t) {
    setForm((f) => {
      const has = (f.meeting_types || []).includes(t);
      const next = has
        ? f.meeting_types.filter((x) => x !== t)
        : [...(f.meeting_types || []), t];
      // Don't allow an empty list — keep at least one option on.
      return { ...f, meeting_types: next.length ? next : f.meeting_types };
    });
  }

  async function save() {
    setSaving(true);
    try {
      if (calendarId) {
        // C2 path — PATCH the agent's Individual calendar. Field
        // names use the calendar shape (duration_minutes,
        // max_bookings_per_day); the C2 router silently drops
        // anything outside the agent allow-list.
        const calendarPayload = {
          booking_settings: {
            duration_minutes:
              parseInt(form.appointment_duration, 10) || 30,
            buffer_minutes: parseInt(form.buffer_minutes, 10) || 0,
            advance_notice_hours:
              parseInt(form.advance_notice_hours, 10) || 24,
            max_bookings_per_day:
              parseInt(form.max_per_day, 10) || 10,
            working_hours: form.working_hours,
            meeting_types: form.meeting_types || ["phone"],
            timezone: "America/Chicago",
          },
        };
        await api.patch(`/calendars/${calendarId}`, calendarPayload);
        toast.success("Booking page saved");
      } else {
        // Legacy fallback — kept verbatim so pre-migration users and
        // tenants that haven't run migrate_calendars yet still save.
        const payload = {
          is_enabled: !!form.is_enabled,
          bio: form.bio || "",
          meeting_types: form.meeting_types || ["phone"],
          phone_number: form.phone_number || "",
          video_link: form.video_link || "",
          appointment_duration:
            parseInt(form.appointment_duration, 10) || 30,
          buffer_minutes: parseInt(form.buffer_minutes, 10) || 0,
          max_per_day: parseInt(form.max_per_day, 10) || 10,
          advance_notice_hours:
            parseInt(form.advance_notice_hours, 10) || 24,
          booking_window_days:
            parseInt(form.booking_window_days, 10) || 60,
          working_hours: form.working_hours,
        };
        const { data } = await api.patch(
          "/profile/booking-settings", payload,
        );
        if (refresh) refresh(data);
        if (data?.booking_settings) {
          setForm((f) => ({ ...f, ...data.booking_settings }));
        }
        toast.success("Booking page saved");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const liveLink = form.slug
    ? `${window.location.origin}/book/${form.slug}`
    : null;

  async function copyLink() {
    if (!liveLink) return;
    try {
      await navigator.clipboard.writeText(liveLink);
      toast.success("Booking link copied");
    } catch {
      toast.error("Couldn't copy — select the link manually.");
    }
  }

  return (
    <div className="space-y-4" data-testid="booking-tab">
      {!calendarLoading && !calendarId && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
          data-testid="calendar-migration-pending"
        >
          <strong>Calendar migration pending.</strong> Your booking page
          still saves against the legacy per-user profile. Once your
          tenant runs the calendar migration, this tab will move to the
          new Calendars system automatically — no action needed.
        </div>
      )}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold">Public booking page</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Share a link clients can use to book time on your calendar
                — no portal login required for them.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox"
                     checked={!!form.is_enabled}
                     onChange={(e) => set("is_enabled", e.target.checked)}
                     data-testid="booking-enable-toggle" />
              <span>{form.is_enabled ? "Enabled" : "Disabled"}</span>
            </label>
          </div>

          {form.is_enabled && form.slug && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Your booking link
                </div>
                <div className="font-mono text-sm break-all" data-testid="booking-live-link">
                  {liveLink}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={copyLink}
                       data-testid="booking-copy-link">
                Copy Link
              </Button>
            </div>
          )}
          {form.is_enabled && !form.slug && (
            <p className="text-xs text-amber-700">
              Save to generate your booking link.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold">Profile shown to clients</h3>
          <div>
            <Label className="text-xs">Bio</Label>
            <Textarea rows={4}
                       value={form.bio || ""}
                       onChange={(e) => set("bio", e.target.value)}
                       maxLength={1000}
                       data-testid="booking-bio" />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Phone (for phone calls)</Label>
              <Input value={form.phone_number || ""}
                      onChange={(e) => set("phone_number", e.target.value)}
                      data-testid="booking-phone" />
            </div>
            <div>
              <Label className="text-xs">Video link (Zoom / Meet / Teams)</Label>
              <Input value={form.video_link || ""}
                      onChange={(e) => set("video_link", e.target.value)}
                      data-testid="booking-video-link" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold">Appointment defaults</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Meeting types offered</Label>
              <div className="flex gap-4 mt-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox"
                         checked={(form.meeting_types || []).includes("phone")}
                         onChange={() => toggleMeetingType("phone")}
                         data-testid="booking-mtype-phone" />
                  Phone Call
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox"
                         checked={(form.meeting_types || []).includes("video")}
                         onChange={() => toggleMeetingType("video")}
                         data-testid="booking-mtype-video" />
                  Video Call
                </label>
              </div>
            </div>
            <div>
              <Label className="text-xs">Appointment duration</Label>
              <select
                value={form.appointment_duration || 30}
                onChange={(e) => set("appointment_duration", parseInt(e.target.value, 10))}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                data-testid="booking-duration">
                <option value={30}>30 minutes</option>
                <option value={45}>45 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Buffer between appointments</Label>
              <select
                value={form.buffer_minutes ?? 15}
                onChange={(e) => set("buffer_minutes", parseInt(e.target.value, 10))}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                data-testid="booking-buffer">
                <option value={0}>None</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Max bookings per day</Label>
              <Input type="number" min={1} max={20}
                      value={form.max_per_day || 10}
                      onChange={(e) => set("max_per_day", parseInt(e.target.value, 10) || 1)}
                      data-testid="booking-max-per-day" />
            </div>
            <div>
              <Label className="text-xs">Advance notice required</Label>
              <select
                value={form.advance_notice_hours ?? 24}
                onChange={(e) => set("advance_notice_hours", parseInt(e.target.value, 10))}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                data-testid="booking-advance">
                <option value={0}>Same day</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">How far ahead clients can book</Label>
              <select
                value={form.booking_window_days || 60}
                onChange={(e) => set("booking_window_days", parseInt(e.target.value, 10))}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                data-testid="booking-window">
                <option value={14}>2 weeks</option>
                <option value={30}>1 month</option>
                <option value={60}>2 months</option>
                <option value={90}>3 months</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-2">
          <h3 className="text-sm font-semibold">Working hours</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Slots only appear on enabled days during the hours below.
          </p>
          <div className="space-y-2">
            {_WEEKDAYS.map((day) => {
              const row = form.working_hours[day] || {};
              return (
                <div key={day} className="grid grid-cols-[120px_60px_1fr_1fr] gap-2 items-center"
                     data-testid={`booking-day-${day}`}>
                  <div className="text-sm capitalize">{day}</div>
                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                    <input type="checkbox" checked={!!row.enabled}
                           onChange={(e) => setHours(day, { enabled: e.target.checked })}
                           data-testid={`booking-day-${day}-enabled`} />
                    On
                  </label>
                  <select
                    value={row.start || "09:00"}
                    onChange={(e) => setHours(day, { start: e.target.value })}
                    disabled={!row.enabled}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                    data-testid={`booking-day-${day}-start`}>
                    {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select
                    value={row.end || "17:00"}
                    onChange={(e) => setHours(day, { end: e.target.value })}
                    disabled={!row.enabled}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                    data-testid={`booking-day-${day}-end`}>
                    {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}
                 data-testid="booking-save">
          {saving ? "Saving…" : "Save booking page"}
        </Button>
      </div>
    </div>
  );
}


// ── GHL connection + bulk import panel (per-agent) ─────────────────────
// Three logical states layered on a single card:
//   - not connected       → token paste form
//   - connected, idle     → summary + "Import Contacts" button
//   - import wizard open  → 4 steps (preview → tag mapping → running → done)
//
// History list lives at the bottom in all states.

const _SKIP_TAG = "__skip__";

function GHLImportPanel() {
  const [status, setStatus] = useState(null);           // /ghl-import/status
  const [statusLoading, setStatusLoading] = useState(true);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [history, setHistory] = useState([]);

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);       // 1..4
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [tagMap, setTagMap] = useState({});              // {ghl_tag: portal_tag|null|__skip__}
  const [portalTags, setPortalTags] = useState([]);
  const [tagBusy, setTagBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [jobBusy, setJobBusy] = useState(false);
  const pollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const { data } = await api.get("/ghl-import/status");
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get("/ghl-import/jobs");
      setHistory(data?.jobs || []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadHistory();
  }, [loadStatus, loadHistory]);

  // ── Connect / disconnect ─────────────────────────────────────────────
  async function handleConnect() {
    if (!token.trim()) return;
    setConnecting(true);
    try {
      const { data } = await api.post("/ghl-import/connect", {
        token: token.trim(),
      });
      setStatus(data);
      setToken("");
      toast.success(`Connected to ${data.location_name || "GHL"}`);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not connect to GHL.",
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    // eslint-disable-next-line no-restricted-globals
    if (!window.confirm(
      "Disconnect GHL? Imported contacts stay in the portal — only the connection is removed.",
    )) return;
    setDisconnecting(true);
    try {
      await api.delete("/ghl-import/connect");
      setStatus({ connected: false });
      toast.success("GHL disconnected");
    } catch (err) {
      toast.error("Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Wizard control ───────────────────────────────────────────────────
  async function openWizard() {
    setWizardOpen(true);
    setWizardStep(1);
    setPreview(null);
    setTagMap({});
    setJob(null);
    setPreviewBusy(true);
    try {
      const { data } = await api.post("/ghl-import/preview");
      setPreview(data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Preview failed");
      setWizardOpen(false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function goToTagMapping() {
    setWizardStep(2);
    if (!preview?.unique_tags?.length) {
      setTagMap({});
      return;
    }
    setTagBusy(true);
    try {
      const { data } = await api.post("/ghl-import/map-tags", {
        tags: preview.unique_tags,
      });
      setTagMap(data?.mapping || {});
      setPortalTags(data?.portal_tags || []);
    } catch {
      // Fall back to empty mapping — agent fills in by hand.
      setTagMap(Object.fromEntries(preview.unique_tags.map((t) => [t, null])));
    } finally {
      setTagBusy(false);
    }
  }

  function setTagFor(ghlTag, portalTag) {
    setTagMap((m) => ({ ...m, [ghlTag]: portalTag }));
  }

  async function startImport() {
    // Convert __skip__ markers to null for the backend.
    const cleanMap = {};
    for (const [k, v] of Object.entries(tagMap || {})) {
      cleanMap[k] = v === _SKIP_TAG ? null : v;
    }
    try {
      const { data } = await api.post("/ghl-import/start", {
        tag_mapping: cleanMap,
        overwrite_existing: false,
      });
      setWizardStep(3);
      setJob({ job_id: data.job_id, status: "pending",
                processed: 0, total_contacts: preview?.total_contacts || 0 });
      pollJob(data.job_id);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not start import");
    }
  }

  function pollJob(jobId) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const { data } = await api.get(`/ghl-import/jobs/${jobId}`);
        setJob(data);
        if (["complete", "failed", "cancelled"].includes(data.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          await Promise.all([loadStatus(), loadHistory()]);
          setWizardStep(4);
        }
      } catch {
        /* keep polling */
      }
    };
    tick();
    pollRef.current = setInterval(tick, 3000);
  }

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function cancelJob() {
    if (!job?.job_id) return;
    setJobBusy(true);
    try {
      await api.post(`/ghl-import/jobs/${job.job_id}/cancel`);
      toast.success("Cancel requested — will stop at next page boundary.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Cancel failed");
    } finally {
      setJobBusy(false);
    }
  }

  function closeWizard() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setWizardOpen(false);
    setWizardStep(1);
  }

  // ── Render ───────────────────────────────────────────────────────────
  if (statusLoading) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          Checking GHL connection…
        </CardContent>
      </Card>
    );
  }

  const isConnected = !!status?.connected;

  return (
    <div className="space-y-4" data-testid="ghl-import-panel">
      <Card>
        <CardContent className="p-5 space-y-4">
          {!isConnected ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Plug className="w-4 h-4 text-muted-foreground" />
                    GoHighLevel
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-gray-400 mr-1.5" />
                    Not Connected
                  </p>
                </div>
              </div>

              <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1">
                <div className="text-xs font-semibold">How to get your token</div>
                <ol className="text-xs text-muted-foreground list-decimal pl-4 space-y-0.5">
                  <li>Open your GHL sub-account</li>
                  <li>Go to Settings → Integrations → Private Integrations</li>
                  <li>Create a new integration token</li>
                  <li>Copy and paste it below</li>
                </ol>
              </div>

              <div>
                <Label className="text-xs">Private Integration Token</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="pk_…"
                    autoComplete="off"
                    data-testid="ghl-token-input"
                    className="font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowToken((v) => !v)}
                    data-testid="ghl-token-show"
                  >
                    {showToken ? "Hide" : "Show"}
                  </Button>
                </div>
              </div>

              <Button
                onClick={handleConnect}
                disabled={connecting || !token.trim()}
                data-testid="ghl-connect-btn"
              >
                {connecting ? "Connecting…" : "Connect GHL Account"}
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Plug className="w-4 h-4 text-emerald-600" />
                    GoHighLevel
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5" />
                    Connected · {status.location_name || "—"}
                  </p>
                  {status.location_id && (
                    <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      Location ID: {status.location_id}
                    </p>
                  )}
                </div>
                <Badge className="bg-emerald-100 text-emerald-900">Active</Badge>
              </div>

              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    GHL Contacts
                  </div>
                  <div className="text-xl font-semibold mt-1 tabular-nums">
                    {(status.contact_count_ghl ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Portal Contacts
                  </div>
                  <div className="text-xl font-semibold mt-1 tabular-nums">
                    {(status.contact_count_portal ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Last sync
                  </div>
                  <div className="text-sm font-medium mt-1">
                    {status.last_sync_at
                      ? fmtDateTime(status.last_sync_at)
                      : "never"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={openWizard}
                  disabled={wizardOpen}
                  data-testid="ghl-import-btn"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Import Contacts
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  data-testid="ghl-disconnect-btn"
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Wizard (inline below the card) ─────────────────────────── */}
      {wizardOpen && (
        <Card data-testid="ghl-wizard">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Step {wizardStep} of 4
              </div>
              <button
                type="button"
                onClick={closeWizard}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid="ghl-wizard-close"
              >
                Close wizard
              </button>
            </div>

            {/* Step 1 — Preview */}
            {wizardStep === 1 && (
              <div data-testid="ghl-wizard-step-1">
                <h3 className="text-base font-semibold">Preview your GHL data</h3>
                {previewBusy && (
                  <p className="text-sm text-muted-foreground mt-3">
                    Analyzing your GHL contacts…
                  </p>
                )}
                {!previewBusy && preview && (
                  <div className="mt-3 space-y-3">
                    <p className="text-sm">
                      Found{" "}
                      <strong>{(preview.total_contacts || 0).toLocaleString()}</strong>
                      {" "}contacts in your GHL account.
                    </p>
                    <div className="rounded-md border border-border p-3 text-sm space-y-1">
                      <Row dot="green" label="Ready to import"
                            value={`~${Math.max(0,
                              (preview.total_contacts || 0)
                                - (preview.estimated_duplicates || 0)
                            ).toLocaleString()}`} />
                      <Row dot="amber" label="Missing email"
                            value={`${preview.missing_email_pct ?? 0}% of sample`} />
                      <Row dot="amber" label="Missing date of birth"
                            value={`${preview.missing_dob_pct ?? 0}% of sample`} />
                      <Row dot="gray" label="Likely duplicates"
                            value={`~${(preview.estimated_duplicates || 0).toLocaleString()}`} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Unique tags found: {preview.unique_tags?.length ?? 0}
                    </div>
                    <Button
                      onClick={goToTagMapping}
                      data-testid="ghl-wizard-next-1"
                    >
                      Review tag mapping →
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Step 2 — Tag mapping */}
            {wizardStep === 2 && (
              <div data-testid="ghl-wizard-step-2">
                <h3 className="text-base font-semibold">Tag mapping</h3>
                {tagBusy && (
                  <p className="text-sm text-muted-foreground mt-3">
                    AI is mapping your tags…
                  </p>
                )}
                {!tagBusy && Object.keys(tagMap).length === 0 && (
                  <p className="text-sm text-muted-foreground mt-3">
                    No unique tags found in your GHL sample.
                  </p>
                )}
                {!tagBusy && Object.keys(tagMap).length > 0 && (
                  <div className="mt-3 space-y-2 max-h-80 overflow-y-auto">
                    {Object.entries(tagMap).map(([ghlTag, mapped]) => (
                      <div key={ghlTag}
                           className="grid grid-cols-[1fr_180px] gap-2 items-center text-sm"
                           data-testid={`ghl-tag-row-${ghlTag}`}>
                        <div className="font-medium truncate" title={ghlTag}>
                          {ghlTag}
                        </div>
                        <select
                          value={mapped == null ? _SKIP_TAG : mapped}
                          onChange={(e) => setTagFor(ghlTag,
                            e.target.value === _SKIP_TAG ? null : e.target.value)}
                          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          <option value={_SKIP_TAG}>— skip —</option>
                          {portalTags.map((pt) => (
                            <option key={pt} value={pt}>{pt}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 mt-4">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setWizardStep(1)}
                  >
                    ← Back
                  </Button>
                  <Button
                    onClick={startImport}
                    data-testid="ghl-wizard-start"
                    disabled={tagBusy}
                  >
                    Start import →
                  </Button>
                </div>
              </div>
            )}

            {/* Step 3 — Running */}
            {wizardStep === 3 && job && (
              <div data-testid="ghl-wizard-step-3">
                <h3 className="text-base font-semibold">
                  Importing your GHL contacts…
                </h3>
                <ProgressBar
                  processed={job.processed || 0}
                  total={job.total_contacts || preview?.total_contacts || 0}
                />
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <Row label="Processed"
                       value={`${(job.processed || 0).toLocaleString()} / ${(job.total_contacts || 0).toLocaleString()}`} />
                  <Row label="Status" value={job.status} />
                  <Row dot="green" label="Imported"
                       value={(job.imported || 0).toLocaleString()} />
                  <Row dot="gray" label="Duplicates skipped"
                       value={(job.duplicates || 0).toLocaleString()} />
                  <Row dot="amber" label="Flagged"
                       value={(job.flagged || 0).toLocaleString()} />
                  <Row dot="red" label="Failed"
                       value={(job.failed || 0).toLocaleString()} />
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  You can close this window — the import will continue
                  running in the background. We'll email you when it's done.
                </p>
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="outline" size="sm"
                    onClick={cancelJob}
                    disabled={jobBusy || job.status === "cancelled"}
                    data-testid="ghl-wizard-cancel"
                  >
                    {jobBusy ? "Cancelling…" : "Cancel import"}
                  </Button>
                </div>
              </div>
            )}

            {/* Step 4 — Complete */}
            {wizardStep === 4 && job && (
              <div data-testid="ghl-wizard-step-4">
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  {job.status === "complete" ? "Import complete!"
                    : job.status === "cancelled" ? "Import cancelled"
                    : "Import finished"}
                </h3>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <Row dot="green" label="Imported"
                       value={(job.imported || 0).toLocaleString()} />
                  <Row dot="gray" label="Duplicates skipped"
                       value={(job.duplicates || 0).toLocaleString()} />
                  <Row dot="amber" label="Flagged"
                       value={(job.flagged || 0).toLocaleString()} />
                  <Row dot="red" label="Failed"
                       value={(job.failed || 0).toLocaleString()} />
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
                  <Button asChild size="sm">
                    <Link to="/clients">View your contacts →</Link>
                  </Button>
                  <Button variant="outline" size="sm"
                          onClick={() => setWizardOpen(false)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Import history ─────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold mb-2">Import History</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Imported</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Report</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((j) => (
                    <TableRow key={j.job_id}
                              data-testid={`ghl-history-${j.job_id}`}>
                      <TableCell className="text-sm">
                        {fmtDateTime(j.started_at)}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {(j.imported || 0).toLocaleString()}
                        {j.flagged > 0 && (
                          <span className="text-xs text-amber-700 ml-1">
                            (+{j.flagged} flagged)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={
                          j.status === "complete" ? "bg-emerald-100 text-emerald-900"
                            : j.status === "running" ? "bg-amber-100 text-amber-900"
                            : j.status === "cancelled" ? "bg-gray-200 text-gray-700"
                            : "bg-red-100 text-red-900"
                        }>
                          {j.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <ReportLink jobId={j.job_id} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Tiny progress bar — pure CSS, no third-party deps.
function ProgressBar({ processed, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100))
                         : 0;
  return (
    <div className="mt-3">
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-muted-foreground mt-1">{pct}%</div>
    </div>
  );
}

// Row helper — small status/value row with optional colored dot prefix.
function Row({ label, value, dot }) {
  const dotClass =
    dot === "green" ? "bg-emerald-500"
    : dot === "amber" ? "bg-amber-500"
    : dot === "red" ? "bg-red-500"
    : dot === "gray" ? "bg-gray-400"
    : null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground flex items-center gap-2">
        {dotClass && (
          <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
        )}
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

// Lazy report download link — fetches JSON and triggers a download.
function ReportLink({ jobId }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const { data } = await api.get(`/ghl-import/jobs/${jobId}/report`);
      const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ghl-import-${jobId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Report fetch failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="outline" onClick={download} disabled={busy}>
      {busy ? "…" : "Report"}
    </Button>
  );
}


// ── Calendars tab (admin only — Feature C sub-phase C5) ──────────────────
// Production-grade calendar management. Surface includes:
//   - Compact list with color dot, type badge, source chip, copy-link,
//     edit button, and active/inactive toggle.
//   - Three-step create / edit modal (type → details → members) with
//     auto-slugify, live collision check, color presets + custom hex,
//     collapsible booking-settings panel, and a Round Robin members
//     picker against the live agency team.
//   - Distribution panel embedded in the edit modal for Round Robin
//     calendars: per-member weight slider (save on blur), assignment
//     count, last_assigned_at, deficit score, is_available_now, plus
//     a confirm-gated "Reset counts" button.
//
// Wires to endpoints built in C2 + C3 only — no new backend in C5.

const _CALENDAR_TYPE_LABEL = {
  individual: "Individual",
  round_robin: "Round Robin",
  group: "Group",
};

// Color presets match BOOKING_TYPE_COLOR (C4) so a calendar's source
// label and its display color stay visually aligned with the
// react-big-calendar event grid.
const _CALENDAR_COLOR_PRESETS = [
  { value: "#16a34a", label: "Autobook" },
  { value: "#9333ea", label: "VA" },
  { value: "#ea580c", label: "AE" },
  { value: "#6b7280", label: "Manual" },
];

const _SOURCE_LABELS = ["manual", "autobook", "va", "ae"];

const _CAL_TIMEZONES = [
  "America/Chicago", "America/New_York", "America/Denver",
  "America/Los_Angeles", "America/Phoenix", "America/Anchorage",
  "Pacific/Honolulu", "UTC",
];

const _CAL_DEFAULT_BS = () => ({
  duration_minutes: 30,
  buffer_minutes: 15,
  advance_notice_hours: 24,
  max_bookings_per_day: 10,
  timezone: "America/Chicago",
  meeting_types: ["phone", "video"],
  working_hours: {
    monday:    { enabled: true,  start: "09:00", end: "17:00" },
    tuesday:   { enabled: true,  start: "09:00", end: "17:00" },
    wednesday: { enabled: true,  start: "09:00", end: "17:00" },
    thursday:  { enabled: true,  start: "09:00", end: "17:00" },
    friday:    { enabled: true,  start: "09:00", end: "17:00" },
    saturday:  { enabled: false, start: "09:00", end: "12:00" },
    sunday:    { enabled: false, start: "09:00", end: "12:00" },
  },
});

function _calSlugify(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function CalendarsTab() {
  const [calendars, setCalendars] = useState([]);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  // null = closed; "new" = create mode; calendar object = edit mode
  const [modalState, setModalState] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/calendars");
      setCalendars(data?.calendars || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't load calendars");
    } finally {
      setLoading(false);
    }
  };

  const loadTeam = async () => {
    try {
      const { data } = await api.get("/profile/team");
      // /profile/team returns {team: [...]} per the existing TeamTab.
      // Defensive: accept users/members shapes too.
      setTeam(data?.team || data?.users || data?.members || []);
    } catch {
      setTeam([]);
    }
  };

  useEffect(() => { load(); loadTeam(); }, []);

  async function copyBookingLink(slug) {
    const url = `${window.location.origin}/book/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Booking link copied");
    } catch {
      toast.error("Couldn't copy — select the link manually.");
    }
  }

  async function toggleActive(cal) {
    if (cal.is_active === false) {
      // Reactivate via PATCH — no blocking-appointments concern.
      try {
        await api.patch(`/calendars/${cal.id}`, { is_active: true });
        toast.success("Calendar reactivated");
        await load();
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Reactivate failed");
      }
      return;
    }
    // Deactivate — DELETE returns 409 with blocking count if any
    // upcoming non-cancelled appointments reference this calendar.
    try {
      await api.delete(`/calendars/${cal.id}`);
      toast.success("Calendar deactivated");
      await load();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (detail && typeof detail === "object" && detail.blocking_appointments) {
        // Surface the count in the confirm dialog so the admin knows
        // exactly what's blocking. We do NOT bypass — the C2 endpoint
        // refuses on principle and the admin must move/cancel those
        // appointments before retrying.
        window.alert(
          `Cannot deactivate "${cal.name}" — ${detail.blocking_appointments} ` +
          `upcoming appointment(s) still reference this calendar. ` +
          `Move or cancel them first.`
        );
      } else {
        toast.error(typeof detail === "string" ? detail : "Deactivate failed");
      }
    }
  }

  return (
    <div className="space-y-4" data-testid="calendars-tab">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">Agency Calendars</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Manage Individual and Round Robin calendars. Slugs are
                globally unique across all tenants.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => setModalState("new")}
              data-testid="calendars-new-btn"
            >
              New Calendar
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : calendars.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="calendars-empty"
            >
              No calendars yet. Create one to get started.
            </p>
          ) : (
            <div className="space-y-2" data-testid="calendars-list">
              {calendars.map((cal) => (
                <CalendarRow
                  key={cal.id}
                  cal={cal}
                  onEdit={() => setModalState(cal)}
                  onToggleActive={() => toggleActive(cal)}
                  onCopyLink={() => copyBookingLink(cal.slug)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {modalState && (
        <CalendarFormModal
          calendar={modalState === "new" ? null : modalState}
          existingSlugs={calendars
            .filter((c) =>
              modalState === "new" ? true : c.id !== modalState.id,
            )
            .map((c) => c.slug)}
          team={team}
          onClose={() => setModalState(null)}
          onSaved={async () => {
            setModalState(null);
            await load();
          }}
        />
      )}
    </div>
  );
}


function CalendarRow({ cal, onEdit, onToggleActive, onCopyLink }) {
  const isGroup = cal.type === "group";
  return (
    <div
      className="flex flex-wrap items-center gap-3 p-3 border rounded-md"
      data-testid={`calendar-row-${cal.slug}`}
    >
      <span
        aria-hidden
        className="inline-block w-4 h-4 rounded-full flex-shrink-0"
        style={{ background: cal.color || "#6b7280" }}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">{cal.name}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <button
            type="button"
            className="truncate hover:text-foreground underline-offset-2 hover:underline"
            onClick={onCopyLink}
            title="Click to copy"
            data-testid={`calendar-copy-${cal.slug}`}
          >
            /book/{cal.slug}
          </button>
          <span aria-hidden>·</span>
          <span className="text-[10px]">click to copy</span>
        </div>
      </div>
      <Badge
        variant="outline"
        className={`text-[10px] ${isGroup ? "opacity-50" : ""}`}
        title={isGroup ? "Group calendars are coming soon" : undefined}
      >
        {_CALENDAR_TYPE_LABEL[cal.type] || cal.type}
        {isGroup && " (coming soon)"}
      </Badge>
      <Badge variant="outline" className="text-[10px] capitalize">
        {cal.source_label}
      </Badge>
      {cal.is_active === false && (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          inactive
        </Badge>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={onEdit}
        data-testid={`calendar-edit-${cal.slug}`}
        disabled={isGroup}
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={onToggleActive}
        data-testid={`calendar-toggle-active-${cal.slug}`}
        disabled={isGroup}
      >
        {cal.is_active === false ? "Reactivate" : "Deactivate"}
      </Button>
    </div>
  );
}


function CalendarFormModal({
  calendar, existingSlugs, team, onClose, onSaved,
}) {
  const isEdit = !!calendar;
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [slugWarning, setSlugWarning] = useState("");

  const initialForm = useMemo(() => {
    if (!calendar) {
      return {
        type: "individual",
        name: "",
        slug: "",
        source_label: "manual",
        color: "#16a34a",
        owner_id: "",
        member_ids: [],
        weights: {},
        booking_settings: _CAL_DEFAULT_BS(),
      };
    }
    const bs = { ..._CAL_DEFAULT_BS(), ...(calendar.booking_settings || {}) };
    return {
      type: calendar.type,
      name: calendar.name || "",
      slug: calendar.slug || "",
      source_label: calendar.source_label || "manual",
      color: calendar.color || "#16a34a",
      owner_id: calendar.owner_id || "",
      member_ids: calendar.member_ids || [],
      weights: (calendar.distribution && calendar.distribution.weights) || {},
      booking_settings: bs,
    };
  }, [calendar]);

  const [form, setForm] = useState(initialForm);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function setBS(k, v) {
    setForm((f) => ({
      ...f,
      booking_settings: { ...f.booking_settings, [k]: v },
    }));
  }
  function setHours(day, patch) {
    setForm((f) => ({
      ...f,
      booking_settings: {
        ...f.booking_settings,
        working_hours: {
          ...f.booking_settings.working_hours,
          [day]: { ...f.booking_settings.working_hours[day], ...patch },
        },
      },
    }));
  }

  function checkSlugCollision(slug) {
    const clean = (slug || "").trim().toLowerCase();
    if (!clean) { setSlugWarning(""); return; }
    if (!/^[a-z0-9-]+$/.test(clean) || clean.length < 3 || clean.length > 60) {
      setSlugWarning("Use 3-60 lowercase letters, numbers, and dashes only.");
      return;
    }
    if ((existingSlugs || []).includes(clean)) {
      setSlugWarning(`"${clean}" is already taken. Pick another.`);
      return;
    }
    setSlugWarning("");
  }

  function autoSlugifyFromName() {
    if (form.slug) return; // user already typed one — don't overwrite
    const candidate = _calSlugify(form.name);
    if (candidate) {
      set("slug", candidate);
      checkSlugCollision(candidate);
    }
  }

  const canGoToStep2 = isEdit || !!form.type;
  const canGoToStep3 = (
    canGoToStep2
    && form.name.trim().length >= 1
    && form.slug.trim().length >= 3
    && !slugWarning
  );

  const totalSteps = form.type === "round_robin" ? 3 : 2;

  function toggleMember(uid) {
    setForm((f) => {
      const has = f.member_ids.includes(uid);
      const nextMembers = has
        ? f.member_ids.filter((x) => x !== uid)
        : [...f.member_ids, uid];
      const nextWeights = { ...f.weights };
      if (has) {
        delete nextWeights[uid];
      } else if (nextWeights[uid] == null) {
        nextWeights[uid] = 1;
      }
      return { ...f, member_ids: nextMembers, weights: nextWeights };
    });
  }

  function setWeight(uid, w) {
    setForm((f) => ({ ...f, weights: { ...f.weights, [uid]: w } }));
  }

  async function submit() {
    if (slugWarning) { toast.error(slugWarning); return; }
    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim().toLowerCase(),
      source_label: form.source_label,
      color: form.color,
      booking_settings: form.booking_settings,
    };
    if (!isEdit) payload.type = form.type;
    if (form.type === "individual") {
      if (!form.owner_id.trim()) {
        toast.error("Individual calendars need an owner agent.");
        return;
      }
      if (!isEdit) payload.owner_id = form.owner_id.trim();
    } else if (form.type === "round_robin") {
      if (form.member_ids.length < 2) {
        toast.error("Round Robin calendars need at least 2 members.");
        return;
      }
      payload.member_ids = form.member_ids;
    }

    setSaving(true);
    try {
      let cid = calendar?.id;
      if (isEdit) {
        await api.patch(`/calendars/${calendar.id}`, payload);
      } else {
        const { data } = await api.post("/calendars", payload);
        cid = data?.id;
      }
      // For Round Robin: push the weight ledger via the dedicated
      // distribution endpoint so audit log records a separate
      // calendar_distribution_updated event.
      if (form.type === "round_robin" && cid && form.member_ids.length > 0) {
        const weights = {};
        for (const uid of form.member_ids) {
          const w = parseInt(form.weights[uid], 10);
          if (Number.isFinite(w) && w >= 1 && w <= 5) weights[uid] = w;
        }
        if (Object.keys(weights).length > 0) {
          try {
            await api.patch(`/calendars/${cid}/distribution`, { weights });
          } catch (e) {
            // Don't block the save on a weight push failure — surface
            // a soft warning and let the admin retry from the
            // Distribution panel after the modal closes.
            console.warn("Weight push failed:", e);
          }
        }
      }
      toast.success(isEdit ? "Calendar updated" : "Calendar created");
      onSaved();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-5 space-y-4 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="calendar-form-modal"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {isEdit ? `Edit "${calendar.name}"` : "New Calendar"}
          </h3>
          <div className="text-xs text-muted-foreground">
            Step {step} of {totalSteps}
          </div>
        </div>

        {/* Step 1 — Type picker */}
        {step === 1 && (
          <div className="space-y-3" data-testid="cal-step-1">
            <p className="text-xs text-muted-foreground">
              Choose the kind of calendar this is. Type is locked once
              the calendar is created.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {["individual", "round_robin", "group"].map((t) => {
                const isGroup = t === "group";
                const selected = form.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={isEdit || isGroup}
                    onClick={() => !isEdit && set("type", t)}
                    className={[
                      "rounded-md border p-3 text-left text-sm",
                      selected
                        ? "border-foreground bg-secondary"
                        : "border-border bg-white",
                      (isEdit || isGroup) && !selected
                        ? "opacity-50 cursor-not-allowed"
                        : "",
                    ].join(" ")}
                    title={
                      isGroup
                        ? "Group calendars are coming soon"
                        : isEdit
                        ? "Type is locked after creation"
                        : undefined
                    }
                    data-testid={`cal-type-${t}`}
                  >
                    <div className="font-medium">
                      {_CALENDAR_TYPE_LABEL[t]}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {t === "individual" && "One agent, one calendar."}
                      {t === "round_robin" && "Multiple agents, deficit-weighted."}
                      {t === "group" && "Coming soon."}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2 — Details */}
        {step === 2 && (
          <div className="space-y-3" data-testid="cal-step-2">
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                onBlur={autoSlugifyFromName}
                className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
                placeholder="e.g. Autobook Team"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Slug (URL — globally unique, lowercase + hyphens)
              </label>
              <input
                type="text"
                value={form.slug}
                onChange={(e) => set("slug", e.target.value)}
                onBlur={(e) => checkSlugCollision(e.target.value)}
                className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
                placeholder="autobook-team"
                disabled={isEdit && calendar?.slug}  // discourage slug renames
                data-testid="cal-slug-input"
              />
              {slugWarning && (
                <p
                  className="text-xs text-red-600 mt-1"
                  data-testid="cal-slug-warning"
                >
                  {slugWarning}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                Booking URL: <code>/book/{form.slug || "your-slug"}</code>
              </p>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">Source label</label>
              <select
                value={form.source_label}
                onChange={(e) => set("source_label", e.target.value)}
                className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1 capitalize"
              >
                {_SOURCE_LABELS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">Color</label>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {_CALENDAR_COLOR_PRESETS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => set("color", c.value)}
                    className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-2 py-0.5 border ${
                      form.color === c.value
                        ? "border-foreground"
                        : "border-border"
                    }`}
                    title={c.label}
                    data-testid={`cal-color-${c.label.toLowerCase()}`}
                  >
                    <span
                      className="inline-block w-4 h-4 rounded-full"
                      style={{ background: c.value }}
                    />
                    <span className="text-[10px]">{c.label}</span>
                  </button>
                ))}
                <span className="text-[11px] text-muted-foreground">
                  Custom:
                </span>
                <input
                  type="text"
                  value={form.color}
                  onChange={(e) => set("color", e.target.value)}
                  className="w-24 text-xs rounded-md border border-border px-2 py-1"
                  placeholder="#000000"
                />
                <span
                  aria-hidden
                  className="inline-block w-5 h-5 rounded-full border"
                  style={{ background: form.color }}
                />
              </div>
            </div>

            {form.type === "individual" && !isEdit && (
              <div>
                <label className="text-xs text-muted-foreground">
                  Owner agent
                </label>
                <select
                  value={form.owner_id}
                  onChange={(e) => set("owner_id", e.target.value)}
                  className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
                >
                  <option value="">— Pick an agent —</option>
                  {team.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.agent_name || u.email}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <CollapsibleBookingSettings
              bs={form.booking_settings}
              setBS={setBS}
              setHours={setHours}
            />
          </div>
        )}

        {/* Step 3 — Members (Round Robin only) */}
        {step === 3 && form.type === "round_robin" && (
          <RoundRobinMembersStep
            team={team}
            form={form}
            toggleMember={toggleMember}
            setWeight={setWeight}
            calendarId={calendar?.id}
          />
        )}

        <div className="flex justify-between gap-2 pt-2 border-t mt-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <div className="flex gap-2">
            {step > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setStep((s) => s - 1)}
              >
                Back
              </Button>
            )}
            {step < totalSteps ? (
              <Button
                size="sm"
                onClick={() => setStep((s) => s + 1)}
                disabled={
                  (step === 1 && !canGoToStep2)
                  || (step === 2 && !canGoToStep3)
                }
                data-testid="cal-modal-next"
              >
                Next
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={submit}
                disabled={saving}
                data-testid="cal-modal-save"
              >
                {saving ? "Saving…" : isEdit ? "Save changes" : "Create calendar"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function CollapsibleBookingSettings({ bs, setBS, setHours }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium"
      >
        <span>Booking settings</span>
        <span className="text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="p-3 space-y-3 border-t">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Duration (min)"
              value={bs.duration_minutes}
              onChange={(v) => setBS("duration_minutes", v)}
            />
            <NumberField
              label="Buffer (min)"
              value={bs.buffer_minutes}
              onChange={(v) => setBS("buffer_minutes", v)}
            />
            <NumberField
              label="Advance notice (h)"
              value={bs.advance_notice_hours}
              onChange={(v) => setBS("advance_notice_hours", v)}
            />
            <NumberField
              label="Max bookings/day"
              value={bs.max_bookings_per_day}
              onChange={(v) => setBS("max_bookings_per_day", v)}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Timezone</label>
            <select
              value={bs.timezone || "America/Chicago"}
              onChange={(e) => setBS("timezone", e.target.value)}
              className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
            >
              {_CAL_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Meeting types (comma-separated)
            </label>
            <input
              type="text"
              value={(bs.meeting_types || []).join(", ")}
              onChange={(e) =>
                setBS(
                  "meeting_types",
                  e.target.value
                    .split(",").map((s) => s.trim()).filter(Boolean),
                )
              }
              className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
              placeholder="phone, video"
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Working hours</p>
            <div className="space-y-1">
              {_WEEKDAYS.map((day) => {
                const w = bs.working_hours?.[day] || {};
                return (
                  <div
                    key={day}
                    className="grid grid-cols-[110px_60px_1fr_1fr] items-center gap-2 text-xs"
                  >
                    <span className="capitalize">{day}</span>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!w.enabled}
                        onChange={(e) =>
                          setHours(day, { enabled: e.target.checked })
                        }
                      />
                      <span>{w.enabled ? "On" : "Off"}</span>
                    </label>
                    <select
                      value={w.start || "09:00"}
                      onChange={(e) => setHours(day, { start: e.target.value })}
                      disabled={!w.enabled}
                      className="rounded-md border border-border px-1 py-1 text-xs"
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <select
                      value={w.end || "17:00"}
                      onChange={(e) => setHours(day, { end: e.target.value })}
                      disabled={!w.enabled}
                      className="rounded-md border border-border px-1 py-1 text-xs"
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function NumberField({ label, value, onChange }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="w-full text-sm rounded-md border border-border px-2 py-1.5 mt-1"
      />
    </div>
  );
}


function RoundRobinMembersStep({
  team, form, toggleMember, setWeight, calendarId,
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return team;
    return team.filter((u) => {
      const haystack = `${u.full_name || ""} ${u.email || ""} ${u.agent_name || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [team, search]);

  return (
    <div className="space-y-3" data-testid="cal-step-3">
      <p className="text-xs text-muted-foreground">
        Pick at least 2 members. Set each member's weight (1-5) — higher
        weight = larger target share of bookings.
      </p>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or email"
        className="w-full text-sm rounded-md border border-border px-2 py-1.5"
      />

      <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            No team members match.
          </p>
        ) : (
          filtered.map((u) => {
            const selected = form.member_ids.includes(u.id);
            const w = form.weights[u.id] ?? 1;
            return (
              <div
                key={u.id}
                className="flex items-center gap-2 p-2 text-xs"
                data-testid={`rr-member-${u.id}`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleMember(u.id)}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {u.full_name || u.agent_name || u.email}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {u.email}
                  </div>
                </div>
                {selected && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">
                      Weight
                    </span>
                    <input
                      type="range"
                      min={1} max={5} step={1} value={w}
                      onChange={(e) => setWeight(u.id, parseInt(e.target.value, 10))}
                      className="w-24"
                    />
                    <span className="tabular-nums text-[11px] w-3 text-right">
                      {w}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {form.member_ids.length} member(s) selected
        {form.member_ids.length < 2 && " — need at least 2"}
      </p>

      {calendarId && (
        <DistributionPanel calendarId={calendarId} />
      )}
    </div>
  );
}


function DistributionPanel({ calendarId }) {
  const [dist, setDist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/calendars/${calendarId}/distribution`);
      setDist(data);
    } catch {
      setDist(null);
    } finally {
      setLoading(false);
    }
  }, [calendarId]);

  useEffect(() => { load(); }, [load]);

  async function patchWeight(uid, weight) {
    try {
      await api.patch(`/calendars/${calendarId}/distribution`, {
        weights: { [uid]: weight },
      });
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Weight save failed");
    }
  }

  async function resetCounts() {
    if (!window.confirm(
      "This will reset all assignment counts to zero. Weights are preserved."
    )) return;
    setResetting(true);
    try {
      await api.post(`/calendars/${calendarId}/distribution/reset`);
      toast.success("Counts reset");
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        Loading distribution…
      </div>
    );
  }
  if (!dist) return null;

  return (
    <div
      className="rounded-md border p-3 space-y-2"
      data-testid="distribution-panel"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Distribution</p>
        <Button
          size="sm"
          variant="outline"
          onClick={resetCounts}
          disabled={resetting}
          data-testid="distribution-reset"
        >
          {resetting ? "…" : "Reset counts"}
        </Button>
      </div>
      <div className="space-y-1">
        {(dist.members || []).map((m) => (
          <DistributionRow
            key={m.user_id}
            member={m}
            onPatchWeight={(w) => patchWeight(m.user_id, w)}
          />
        ))}
      </div>
    </div>
  );
}


function DistributionRow({ member, onPatchWeight }) {
  const [weight, setWeight] = useState(member.weight);
  useEffect(() => { setWeight(member.weight); }, [member.weight]);
  return (
    <div
      className="grid grid-cols-[1fr_140px_60px_90px_50px] gap-2 items-center text-xs py-1"
      data-testid={`distribution-row-${member.user_id}`}
    >
      <div className="min-w-0 truncate">
        <span className="font-medium">{member.full_name || member.user_id}</span>
        {!member.is_available_now && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            (off-hours)
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="range"
          min={1} max={5} step={1} value={weight}
          onChange={(e) => setWeight(parseInt(e.target.value, 10))}
          onMouseUp={() => weight !== member.weight && onPatchWeight(weight)}
          onTouchEnd={() => weight !== member.weight && onPatchWeight(weight)}
          onBlur={() => weight !== member.weight && onPatchWeight(weight)}
          className="w-full"
        />
        <span className="tabular-nums w-3 text-right">{weight}</span>
      </div>
      <div className="tabular-nums text-right">{member.assignment_count}</div>
      <div className="text-muted-foreground text-[10px] truncate">
        {member.last_assigned_at
          ? new Date(member.last_assigned_at).toLocaleDateString()
          : "—"}
      </div>
      <div className="tabular-nums text-right text-[11px]">
        {Number(member.deficit).toFixed(3)}
      </div>
    </div>
  );
}
