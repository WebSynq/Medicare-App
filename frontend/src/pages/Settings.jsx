import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
  Lock,
  KeyRound,
  Plug,
  Building2,
  Users2,
  Activity,
  Download,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Settings as SettingsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

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

// ── Profile tab ──────────────────────────────────────────────────────────
function ProfileTab({ me, refresh }) {
  const isAdmin = me?.role === "admin";

  const [profileForm, setProfileForm] = useState({
    full_name: me?.full_name || "",
    email: me?.email || "",
    phone: me?.phone || "",
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
      agent_npn: me?.agent_npn || "",
      agency_name: me?.agency_name || "",
    }));
  }, [me?.full_name, me?.email, me?.phone, me?.agent_npn, me?.agency_name]);

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
function SecurityTab({ me, refresh }) {
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [mfaSetup, setMfaSetup] = useState(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaModalOpen, setMfaModalOpen] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);

  const [disablePassword, setDisablePassword] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);

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

  async function beginEnroll() {
    try {
      const { data } = await api.get("/profile/mfa/setup");
      setMfaSetup(data);
      setMfaCode("");
      setMfaModalOpen(true);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "MFA setup failed"
      );
    }
  }

  async function verifyEnroll() {
    if (!mfaCode) {
      toast.error("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setMfaBusy(true);
    try {
      await api.post("/profile/mfa/verify", { token: mfaCode });
      toast.success("MFA enabled.");
      setMfaModalOpen(false);
      setMfaSetup(null);
      setMfaCode("");
      refresh();
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Verification failed"
      );
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableMfa() {
    if (!disablePassword) {
      toast.error("Confirm with your current password.");
      return;
    }
    setMfaBusy(true);
    try {
      await api.delete("/profile/mfa", {
        data: { current_password: disablePassword },
      });
      toast.success("MFA disabled.");
      setDisableOpen(false);
      setDisablePassword("");
      refresh();
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Disable failed"
      );
    } finally {
      setMfaBusy(false);
    }
  }

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
            <Lock className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Two-Factor Authentication</h3>
          </div>
          {me?.mfa_enabled ? (
            <>
              <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
                <ShieldCheck className="w-3 h-3 mr-1" /> MFA Enabled
              </Badge>
              <p className="text-xs text-muted-foreground">
                Authenticator codes are required at sign-in.
              </p>
              {disableOpen ? (
                <div className="space-y-2 border-t border-border pt-3">
                  <Label className="text-xs">Confirm with current password</Label>
                  <Input
                    type="password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    autoComplete="current-password"
                    data-testid="mfa-disable-pw"
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={disableMfa}
                      disabled={mfaBusy}
                      variant="destructive"
                      data-testid="mfa-disable-confirm"
                    >
                      {mfaBusy ? "Disabling…" : "Disable MFA"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDisableOpen(false);
                        setDisablePassword("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setDisableOpen(true)}
                  data-testid="mfa-disable-btn"
                >
                  Disable MFA
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Two-factor authentication is not enabled.
              </p>
              <Button onClick={beginEnroll} data-testid="mfa-enable-btn">
                <KeyRound className="w-3.5 h-3.5 mr-1.5" /> Enable MFA
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {mfaModalOpen && mfaSetup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          data-testid="mfa-setup-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMfaModalOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl p-6 bg-white shadow-xl space-y-3">
            <h2 className="text-lg font-semibold text-[#1e2d3d]">
              Enable Two-Factor Authentication
            </h2>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
              <li>Open your authenticator app (Google Authenticator, Authy, 1Password…)</li>
              <li>Scan the QR code below, or paste the key manually</li>
              <li>Enter the 6-digit code the app generates</li>
            </ol>
            <div className="flex justify-center">
              {mfaSetup.qr_png_base64 ? (
                <img
                  src={`data:image/png;base64,${mfaSetup.qr_png_base64}`}
                  alt="MFA QR code"
                  width={192}
                  height={192}
                />
              ) : (
                <code className="block text-xs break-all bg-secondary p-3 rounded">
                  {mfaSetup.qr_uri}
                </code>
              )}
            </div>
            <div>
              <Label className="text-xs">Manual entry key</Label>
              <Input value={mfaSetup.secret} readOnly className="font-mono text-xs" />
            </div>
            <div>
              <Label className="text-xs">Verification code</Label>
              <Input
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.trim())}
                placeholder="123 456"
                inputMode="numeric"
                autoComplete="one-time-code"
                data-testid="mfa-verify-code"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setMfaModalOpen(false);
                  setMfaSetup(null);
                  setMfaCode("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={verifyEnroll}
                disabled={mfaBusy}
                data-testid="mfa-verify-btn"
              >
                {mfaBusy ? "Verifying…" : "Verify & Enable"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Audit Log tab ────────────────────────────────────────────────────────
function AuditLogTab({ me }) {
  const isPrivileged = me?.role === "admin" || me?.role === "compliance";
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
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && pageRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No audit entries match these filters.
                  </TableCell>
                </TableRow>
              )}
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
  );
}

// ── Integrations tab (admin only) ────────────────────────────────────────
function IntegrationsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  const cards = [
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
          ? `Last sync: ${fmtDateTime(
              data.comtrack.metadata.last_successful_sync
            )}`
          : "No successful sync yet",
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Checked {fmtDateTime(data.checked_at)} · All checks are read-only.
        </p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
        </Button>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        {cards.map(({ key, title, info, lines }) => (
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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Team tab (admin only) ────────────────────────────────────────────────
function TeamTab() {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("agent");
  const [inviting, setInviting] = useState(false);

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
      await api.post("/auth/invite", {
        email: inviteEmail.trim(),
        full_name: "",
        agency_name: "",
      });
      toast.success(`Invite sent to ${inviteEmail}.`);
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
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="compliance">Compliance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            onClick={sendInvite}
            disabled={inviting}
            data-testid="team-invite-send"
          >
            {inviting ? "Sending…" : "Send invite"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            The role dropdown is informational on this tab — the invite link
            creates an agent by default. Use Agent Management to upgrade a
            user's role after they accept.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold">Pending Invites</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitesLoading && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-4">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!invitesLoading && invites.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-4">
                    No active invites.
                  </TableCell>
                </TableRow>
              )}
              {invites.map((iv) => (
                <TableRow key={iv.id}>
                  <TableCell className="text-sm">{iv.email}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtDateTime(iv.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {fmtDateTime(iv.expires_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Active Team</h3>
            <Button asChild variant="outline" size="sm">
              <Link to="/audit">
                Manage agents
                <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </Link>
            </Button>
          </div>
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
              {teamLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!teamLoading && team.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No team members yet.
                  </TableCell>
                </TableRow>
              )}
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
        </CardContent>
      </Card>
    </div>
  );
}

// ── Top-level page ───────────────────────────────────────────────────────
export default function Settings() {
  const [me, setMe] = useState(null);
  const cachedUser = auth.getUser();
  const role = me?.role || cachedUser?.role || "agent";
  const isAdmin = role === "admin";

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
            Manage your profile, security, audit trail
            {isAdmin && ", agency, integrations, and team"}.
          </p>
        </div>

        <Tabs defaultValue="profile" className="w-full">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="profile" data-testid="tab-profile">
              Profile
            </TabsTrigger>
            <TabsTrigger value="security" data-testid="tab-security">
              Security
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              Audit Log
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="agency" data-testid="tab-agency">
                Agency
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="integrations" data-testid="tab-integrations">
                Integrations
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="team" data-testid="tab-team">
                Team
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="profile" className="mt-4">
            <ProfileTab me={me} refresh={applyPatched} />
          </TabsContent>
          <TabsContent value="security" className="mt-4">
            <SecurityTab me={me} refresh={loadMe} />
          </TabsContent>
          <TabsContent value="audit" className="mt-4">
            <AuditLogTab me={me} />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="agency" className="mt-4">
              <AgencyTab />
            </TabsContent>
          )}
          {isAdmin && (
            <TabsContent value="integrations" className="mt-4">
              <IntegrationsTab />
            </TabsContent>
          )}
          {isAdmin && (
            <TabsContent value="team" className="mt-4">
              <TeamTab />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
}
