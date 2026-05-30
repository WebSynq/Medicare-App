"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Power,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ghl as ghlApi, isApiError } from "@/lib/api";

export function IntegrationsSettingsTab() {
  const statusQuery = useQuery({
    queryKey: ["ghl", "status"],
    queryFn: () => ghlApi.getStatus(),
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <GhlCard
        connected={statusQuery.data?.connected ?? false}
        loading={statusQuery.isLoading}
        locationName={statusQuery.data?.location_name ?? null}
        locationId={statusQuery.data?.location_id ?? null}
        connectedAt={statusQuery.data?.connected_at ?? null}
        contactCountGhl={statusQuery.data?.contact_count_ghl ?? null}
        contactCountPortal={statusQuery.data?.contact_count_portal ?? null}
      />
    </div>
  );
}

function GhlCard({
  connected,
  loading,
  locationName,
  locationId,
  connectedAt,
  contactCountGhl,
  contactCountPortal,
}: {
  connected: boolean;
  loading: boolean;
  locationName: string | null;
  locationId: string | null;
  connectedAt: string | null;
  contactCountGhl: number | null;
  contactCountPortal: number | null;
}) {
  const qc = useQueryClient();
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);

  const connectMutation = useMutation({
    mutationFn: () => ghlApi.connect({ token: token.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ghl", "status"] });
      setConnectOpen(false);
      setToken("");
      toast.success("GoHighLevel connected.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Connection failed."),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => ghlApi.disconnect(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ghl", "status"] });
      setDisconnectOpen(false);
      toast.success("GoHighLevel disconnected.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Disconnect failed."),
  });

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <>
      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                <Link2 className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  GoHighLevel
                  {connected ? (
                    <Badge
                      variant="outline"
                      className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30 text-[10px]"
                    >
                      <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                      Connected
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-muted text-muted-foreground border-border text-[10px]"
                    >
                      Not connected
                    </Badge>
                  )}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Connect your GHL location to import contacts and keep leads
                  in sync.
                </p>
              </div>
            </div>
          </div>

          {connected ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <Field
                  label="Location"
                  value={locationName ?? locationId ?? "—"}
                />
                <Field
                  label="Connected"
                  value={
                    connectedAt
                      ? new Date(connectedAt).toLocaleDateString()
                      : "—"
                  }
                />
                <Field
                  label="Contacts in GHL"
                  value={
                    contactCountGhl != null
                      ? contactCountGhl.toLocaleString()
                      : "—"
                  }
                />
                <Field
                  label="Imported"
                  value={
                    contactCountPortal != null
                      ? contactCountPortal.toLocaleString()
                      : "—"
                  }
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConnectOpen(true)}
                >
                  <Link2 className="h-3 w-3 mr-1.5" />
                  Replace token
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDisconnectOpen(true)}
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  <Power className="h-3 w-3 mr-1.5" />
                  Disconnect
                </Button>
                <Button variant="ghost" size="sm" disabled>
                  <Users className="h-3 w-3 mr-1.5" />
                  Run bulk import…
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground -mt-2">
                Bulk import wizard ships in a follow-up phase.
              </p>
            </>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-3">
                Paste your Private Integration Token to connect. Find it in
                GHL → Settings → Private Integrations.
              </p>
              <Button onClick={() => setConnectOpen(true)}>
                <Link2 className="h-3.5 w-3.5 mr-1.5" />
                Connect GHL
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect GoHighLevel</DialogTitle>
            <DialogDescription>
              Paste your Private Integration Token. We validate it against
              GHL&apos;s /locations endpoint before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-[11px] text-muted-foreground">
              Private Integration Token
            </Label>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="pit-…"
                className="pr-9 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showToken ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Stored encrypted at rest. Never returned in responses.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConnectOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => connectMutation.mutate()}
              disabled={token.trim().length < 10 || connectMutation.isPending}
            >
              {connectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect GoHighLevel?</DialogTitle>
            <DialogDescription className="flex items-start gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-ghw-copper flex-shrink-0 mt-0.5" />
              <span>
                Your token will be removed. Already-imported contacts stay in
                the portal — only future sync stops.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDisconnectOpen(false)}
            >
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              )}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-secondary/30 p-2.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
        {label}
      </p>
      <p className="font-medium truncate mt-0.5">{value}</p>
    </div>
  );
}
