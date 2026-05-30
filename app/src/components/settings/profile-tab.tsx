"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Eye, EyeOff, KeyRound, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError, profile as profileApi } from "@/lib/api";
import type { ProfilePatchPayload } from "@/types";

export function ProfileSettingsTab() {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["profile", "me"],
    queryFn: () => profileApi.getMe(),
  });

  const [draft, setDraft] = React.useState({
    full_name: "",
    email: "",
    phone: "",
    timezone: "",
    agent_npn: "",
  });

  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showCurrent, setShowCurrent] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [pwIssues, setPwIssues] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (meQuery.data) {
      setDraft({
        full_name: meQuery.data.full_name ?? "",
        email: meQuery.data.email ?? "",
        phone: meQuery.data.phone ?? "",
        timezone: meQuery.data.timezone ?? "",
        agent_npn: meQuery.data.agent_npn ?? "",
      });
    }
  }, [meQuery.data]);

  const patchMutation = useMutation({
    mutationFn: (payload: ProfilePatchPayload) => profileApi.patchMe(payload),
    onSuccess: (data) => {
      qc.setQueryData(["profile", "me"], data);
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwIssues([]);
      toast.success("Profile saved.");
    },
    onError: (err: unknown) => {
      if (isApiError(err)) {
        // 422 from the password validator returns a JSON list of
        // unmet requirements — surface them inline.
        const detail = err.body?.detail;
        const requirements =
          typeof detail === "object" && detail !== null
            ? (detail.requirements as unknown)
            : undefined;
        if (Array.isArray(requirements) && requirements.length > 0) {
          setPwIssues(requirements as string[]);
          toast.error("Password doesn't meet requirements.");
          return;
        }
        toast.error(err.message);
      } else {
        toast.error("Save failed.");
      }
    },
  });

  if (meQuery.isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (meQuery.isError || !meQuery.data) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Couldn&apos;t load profile.
        </CardContent>
      </Card>
    );
  }

  const me = meQuery.data;

  function buildPayload(includePassword: boolean): ProfilePatchPayload | null {
    if (!currentPassword) return null;
    const payload: ProfilePatchPayload = {
      current_password: currentPassword,
    };
    if (draft.email !== me.email) payload.email = draft.email.trim();
    if (draft.full_name !== (me.full_name ?? ""))
      payload.full_name = draft.full_name.trim();
    if (draft.phone !== (me.phone ?? "")) payload.phone = draft.phone.trim();
    if (draft.timezone !== (me.timezone ?? ""))
      payload.timezone = draft.timezone.trim();
    if (draft.agent_npn !== (me.agent_npn ?? ""))
      payload.agent_npn = draft.agent_npn.trim();
    if (includePassword) payload.new_password = newPassword;
    return payload;
  }

  function submitProfile() {
    const payload = buildPayload(false);
    if (!payload) {
      toast.error("Enter your current password to save.");
      return;
    }
    patchMutation.mutate(payload);
  }

  function submitPassword() {
    if (!currentPassword) {
      toast.error("Current password is required.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation don't match.");
      return;
    }
    if (newPassword.length < 12) {
      toast.error("New password must be at least 12 characters.");
      return;
    }
    const payload = buildPayload(true);
    if (!payload) return;
    patchMutation.mutate(payload);
  }

  const profileDirty =
    draft.full_name !== (me.full_name ?? "") ||
    draft.email !== me.email ||
    draft.phone !== (me.phone ?? "") ||
    draft.timezone !== (me.timezone ?? "") ||
    draft.agent_npn !== (me.agent_npn ?? "");

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Profile</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Updates require your current password.
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground uppercase tracking-widest">
                Role
              </p>
              <p className="text-xs font-medium capitalize">{me.role}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Full name">
              <Input
                value={draft.full_name}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, full_name: e.target.value }))
                }
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={draft.email}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, email: e.target.value }))
                }
              />
            </Field>
            <Field label="Phone">
              <Input
                type="tel"
                value={draft.phone}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, phone: e.target.value }))
                }
              />
            </Field>
            <Field label="NPN">
              <Input
                value={draft.agent_npn}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, agent_npn: e.target.value }))
                }
                placeholder="5-10 digits"
              />
            </Field>
            <Field label="Timezone (IANA)">
              <Input
                value={draft.timezone}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, timezone: e.target.value }))
                }
                placeholder="America/Chicago"
              />
            </Field>
            <Field label="Agent name (system)">
              <Input value={me.agent_name ?? ""} disabled />
            </Field>
          </div>

          <Separator />

          <Field label="Current password (required to save)">
            <PasswordInput
              value={currentPassword}
              onChange={setCurrentPassword}
              show={showCurrent}
              onToggle={() => setShowCurrent((v) => !v)}
            />
          </Field>

          <div className="flex justify-end">
            <Button
              onClick={submitProfile}
              disabled={
                !profileDirty || !currentPassword || patchMutation.isPending
              }
            >
              {patchMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save profile
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Change password</h3>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Minimum 12 characters. Cannot match any of your last 5 passwords.
          </p>

          <Field label="New password">
            <PasswordInput
              value={newPassword}
              onChange={setNewPassword}
              show={showNew}
              onToggle={() => setShowNew((v) => !v)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type={showNew ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          {pwIssues.length > 0 ? (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3">
              <div className="flex items-center gap-1.5 text-destructive mb-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">
                  Password doesn&apos;t meet requirements
                </span>
              </div>
              <ul className="text-xs text-destructive space-y-0.5 list-disc list-inside">
                {pwIssues.map((iss, i) => (
                  <li key={i}>{iss}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              onClick={submitPassword}
              disabled={
                !currentPassword ||
                !newPassword ||
                !confirmPassword ||
                patchMutation.isPending
              }
            >
              {patchMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5 mr-1.5" />
              )}
              Update password
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  show,
  onToggle,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete?: string;
}) {
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="pr-9"
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

