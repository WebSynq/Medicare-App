"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Plug,
  Sparkles,
  Tag as TagIcon,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ghl as ghlApi, isApiError } from "@/lib/api";
import type {
  GhlImportJob,
  GhlPreviewResponse,
  GhlTagMappingResponse,
} from "@/lib/api/ghl";
import type { GhlIntegrationStatus } from "@/types";

type Step = "connect" | "preview" | "mapping" | "running";

const STEP_ORDER: { id: Step; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "preview", label: "Preview" },
  { id: "mapping", label: "Tag Mapping" },
  { id: "running", label: "Import" },
];

const SKIP_VALUE = "__skip__";

export default function GhlImportPage() {
  const [step, setStep] = React.useState<Step>("connect");
  const [preview, setPreview] = React.useState<GhlPreviewResponse | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, string | null>>(
    {},
  );
  const [portalTags, setPortalTags] = React.useState<string[]>([]);
  const [jobId, setJobId] = React.useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ghl-import", "status"],
    queryFn: ghlApi.getStatus,
  });

  // When the page loads with a healthy connection, skip Connect.
  React.useEffect(() => {
    if (statusQuery.data?.connected && step === "connect") {
      setStep("preview");
    }
  }, [statusQuery.data?.connected, step]);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <Link
        href="/clients"
        className="text-xs text-muted-foreground inline-flex items-center hover:text-primary"
      >
        <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Clients
      </Link>

      <header>
        <div className="flex items-center gap-2 mb-1">
          <Upload className="h-4 w-4 text-primary" />
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Bulk Operations · GoHighLevel
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight font-display">
          Import Leads from GHL
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste a Private Integration Token from your GoHighLevel
          sub-account to bulk-import contacts.
        </p>
      </header>

      <StepBar current={step} />

      {step === "connect" && (
        <ConnectStep
          status={statusQuery.data}
          loading={statusQuery.isLoading}
          onConnected={async () => {
            await statusQuery.refetch();
            setStep("preview");
          }}
          onDisconnected={() => statusQuery.refetch()}
        />
      )}

      {step === "preview" && (
        <PreviewStep
          onBack={() => setStep("connect")}
          onPreviewLoaded={(p) => setPreview(p)}
          preview={preview}
          onNext={() => setStep("mapping")}
        />
      )}

      {step === "mapping" && preview && (
        <MappingStep
          preview={preview}
          mapping={mapping}
          portalTags={portalTags}
          onMappingChange={setMapping}
          onPortalTagsLoaded={setPortalTags}
          onBack={() => setStep("preview")}
          onStart={(id) => {
            setJobId(id);
            setStep("running");
          }}
        />
      )}

      {step === "running" && jobId && (
        <RunningStep
          jobId={jobId}
          onStartOver={() => {
            setPreview(null);
            setMapping({});
            setJobId(null);
            setStep("preview");
          }}
        />
      )}
    </div>
  );
}

function StepBar({ current }: { current: Step }) {
  const currentIdx = STEP_ORDER.findIndex((s) => s.id === current);
  return (
    <div className="flex items-center gap-2 text-xs">
      {STEP_ORDER.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <React.Fragment key={s.id}>
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full border",
                active && "border-primary text-primary bg-primary/10",
                done && "border-ghw-forest/40 text-ghw-forest bg-ghw-forest/10",
                !active &&
                  !done &&
                  "border-border text-muted-foreground",
              )}
            >
              <span className="font-semibold tabular-nums">{i + 1}</span>
              <span>{s.label}</span>
            </div>
            {i < STEP_ORDER.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Step 1: Connect ───────────────────────────────────────────────────────

function ConnectStep({
  status,
  loading,
  onConnected,
  onDisconnected,
}: {
  status: GhlIntegrationStatus | undefined;
  loading: boolean;
  onConnected: () => void;
  onDisconnected: () => void;
}) {
  const [token, setToken] = React.useState("");

  const connect = useMutation({
    mutationFn: (t: string) => ghlApi.connect({ token: t }),
    onSuccess: () => {
      toast.success("GHL connected");
      setToken("");
      onConnected();
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Could not connect");
    },
  });

  const disconnect = useMutation({
    mutationFn: () => ghlApi.disconnect(),
    onSuccess: () => {
      toast.success("Disconnected");
      onDisconnected();
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Could not disconnect");
    },
  });

  if (loading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (status?.connected) {
    return (
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2 text-ghw-forest text-sm font-semibold">
            <Plug className="h-4 w-4" /> Connected to{" "}
            {status.location_name ?? "GHL"}
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            {typeof status.contact_count_ghl === "number" && (
              <div>
                Contacts in GHL:{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {status.contact_count_ghl.toLocaleString()}
                </span>
              </div>
            )}
            {typeof status.contact_count_portal === "number" && (
              <div>
                Imported into portal:{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {status.contact_count_portal.toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={onConnected}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Start Import
            </Button>
            <Button
              variant="outline"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <h3 className="text-sm font-semibold">
          Paste your Private Integration Token
        </h3>
        <p className="text-xs text-muted-foreground">
          In GHL, go to Settings → My Integrations → Private Integrations.
          The token is encrypted at rest and never returned by the API.
        </p>
        <div className="space-y-2">
          <Label htmlFor="ghl-token" className="text-xs">
            Token
          </Label>
          <Input
            id="ghl-token"
            type="password"
            placeholder="ghl-pit-xxxxxxxxxxxxxxxx"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>
        <Button
          onClick={() => connect.mutate(token.trim())}
          disabled={!token.trim() || connect.isPending}
        >
          {connect.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Validating…
            </>
          ) : (
            <>
              <Plug className="h-3.5 w-3.5 mr-1.5" />
              Connect
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Step 2: Preview ───────────────────────────────────────────────────────

function PreviewStep({
  onBack,
  onPreviewLoaded,
  preview,
  onNext,
}: {
  onBack: () => void;
  onPreviewLoaded: (p: GhlPreviewResponse) => void;
  preview: GhlPreviewResponse | null;
  onNext: () => void;
}) {
  const previewMutation = useMutation({
    mutationFn: () => ghlApi.preview(),
    onSuccess: (data) => onPreviewLoaded(data),
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Preview failed");
    },
  });

  React.useEffect(() => {
    if (!preview && !previewMutation.isPending) {
      previewMutation.mutate();
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (previewMutation.isPending || (!preview && !previewMutation.isError)) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <Loader2 className="h-6 w-6 mx-auto animate-spin text-primary" />
          <p className="text-sm">Fetching a sample of your GHL contacts…</p>
        </CardContent>
      </Card>
    );
  }

  if (!preview) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <XCircle className="h-6 w-6 mx-auto text-destructive" />
          <p className="text-sm">Could not fetch preview.</p>
          <Button onClick={() => previewMutation.mutate()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="Total contacts"
          value={preview.total_contacts.toLocaleString()}
        />
        <StatTile
          label="Sample size"
          value={preview.sample_size.toLocaleString()}
        />
        <StatTile
          label="Estimated dupes"
          value={preview.estimated_duplicates.toLocaleString()}
          tone={preview.estimated_duplicates > 0 ? "warn" : undefined}
        />
        <StatTile
          label="Missing email"
          value={`${preview.missing_email_pct.toFixed(1)}%`}
          tone={preview.missing_email_pct > 25 ? "warn" : undefined}
        />
      </div>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold">Detected fields</h3>
          {(preview.sample_fields ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No fields detected in the sample.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {preview.sample_fields.map((f) => (
                <Badge key={f} variant="secondary" className="text-xs">
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <TagIcon className="h-4 w-4" />
            Tags in sample ({preview.unique_tags.length})
          </h3>
          {preview.unique_tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No tags found in the sample.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {preview.unique_tags.map((t) => (
                <Badge key={t} variant="outline" className="text-xs">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back
        </Button>
        <Button onClick={onNext}>
          Continue to Tag Mapping
        </Button>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <Card
      className={cn(
        tone === "warn" && "border-ghw-copper/40 bg-ghw-copper/5",
      )}
    >
      <CardContent className="p-4 space-y-1">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

// ─── Step 3: Tag mapping ───────────────────────────────────────────────────

function MappingStep({
  preview,
  mapping,
  portalTags,
  onMappingChange,
  onPortalTagsLoaded,
  onBack,
  onStart,
}: {
  preview: GhlPreviewResponse;
  mapping: Record<string, string | null>;
  portalTags: string[];
  onMappingChange: (m: Record<string, string | null>) => void;
  onPortalTagsLoaded: (tags: string[]) => void;
  onBack: () => void;
  onStart: (jobId: string) => void;
}) {
  const aiMapMutation = useMutation({
    mutationFn: (tags: string[]) => ghlApi.mapTags(tags),
    onSuccess: (data: GhlTagMappingResponse) => {
      const next: Record<string, string | null> = { ...mapping };
      for (const [k, v] of Object.entries(data.mapping ?? {})) {
        if (next[k] == null) next[k] = v;
      }
      onMappingChange(next);
      onPortalTagsLoaded(data.portal_tags ?? []);
      if (Object.keys(data.mapping ?? {}).length > 0) {
        toast.success("AI tag suggestions loaded");
      }
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "AI mapping unavailable");
    },
  });

  const startMutation = useMutation({
    mutationFn: () =>
      ghlApi.startImport({
        tag_mapping: mapping,
        overwrite_existing: false,
      }),
    onSuccess: (data) => {
      toast.success("Import started");
      onStart(data.job_id);
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Could not start import");
    },
  });

  React.useEffect(() => {
    if (preview.unique_tags.length > 0 && portalTags.length === 0) {
      aiMapMutation.mutate(preview.unique_tags);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTag(ghlTag: string, value: string) {
    const next = {
      ...mapping,
      [ghlTag]: value === SKIP_VALUE ? null : value,
    };
    onMappingChange(next);
  }

  if (preview.unique_tags.length === 0) {
    return (
      <Card>
        <CardContent className="p-5 space-y-3">
          <p className="text-sm">
            No tags to map — your GHL contacts will import without tag
            translation.
          </p>
          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Back
            </Button>
            <Button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? "Starting…" : "Start Import"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <TagIcon className="h-4 w-4" />
              Map GHL tags to portal tags
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Pick a portal tag for each GHL tag. Set to{" "}
              <span className="font-medium">— skip —</span> to drop a tag
              from the import. AI suggestions populate automatically.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => aiMapMutation.mutate(preview.unique_tags)}
            disabled={aiMapMutation.isPending}
          >
            {aiMapMutation.isPending ? "Re-mapping…" : "Re-run AI mapping"}
          </Button>
        </div>

        <div className="space-y-2 max-h-96 overflow-y-auto">
          {preview.unique_tags.map((ghlTag) => {
            const current = mapping[ghlTag];
            const value = current ?? SKIP_VALUE;
            return (
              <div
                key={ghlTag}
                className="flex items-center gap-3 p-2 rounded border border-border bg-card"
              >
                <Badge variant="secondary" className="text-xs flex-shrink-0">
                  {ghlTag}
                </Badge>
                <span className="text-muted-foreground text-xs">→</span>
                <div className="flex-1">
                  <Select value={value} onValueChange={(v) => setTag(ghlTag, v)}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP_VALUE}>— skip —</SelectItem>
                      {portalTags.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {tag}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back
          </Button>
          <Button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
          >
            {startMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Start Import
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Step 4: Running + Done ────────────────────────────────────────────────

function RunningStep({
  jobId,
  onStartOver,
}: {
  jobId: string;
  onStartOver: () => void;
}) {
  const query = useQuery<GhlImportJob>({
    queryKey: ["ghl-import", "job", jobId],
    queryFn: () => ghlApi.getJob(jobId),
    refetchInterval: (q) => {
      const job = q.state.data;
      if (!job) return 3_000;
      if (["pending", "running"].includes(job.status)) return 3_000;
      return false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => ghlApi.cancelJob(jobId),
    onSuccess: () => {
      toast.success("Import cancelled");
      query.refetch();
    },
    onError: (err) => {
      toast.error(isApiError(err) ? err.message : "Cancel failed");
    },
  });

  const job = query.data;
  const running = job?.status === "pending" || job?.status === "running";
  const done = job?.status === "complete";
  const failed = job?.status === "failed" || job?.status === "cancelled";

  const total = job?.total_contacts ?? 0;
  const processed = job?.processed ?? 0;
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          {running && (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          )}
          {done && <CheckCircle2 className="h-4 w-4 text-ghw-forest" />}
          {failed && <AlertTriangle className="h-4 w-4 text-destructive" />}
          <h3 className="text-sm font-semibold">
            {running && "Import running…"}
            {done && "Import complete"}
            {failed && `Import ${job?.status}`}
            {!job && "Starting…"}
          </h3>
          {job && (
            <Badge variant="outline" className="ml-auto text-[10px]">
              Job {job.job_id.slice(0, 8)}…
            </Badge>
          )}
        </div>

        <div>
          <Progress value={pct} className="h-2" />
          <p className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
            {processed.toLocaleString()} / {total.toLocaleString()} processed
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            label="Imported"
            value={(job?.imported ?? 0).toLocaleString()}
          />
          <StatTile
            label="Duplicates"
            value={(job?.duplicates ?? 0).toLocaleString()}
          />
          <StatTile
            label="Flagged"
            value={(job?.flagged ?? 0).toLocaleString()}
            tone={(job?.flagged ?? 0) > 0 ? "warn" : undefined}
          />
          <StatTile
            label="Failed"
            value={(job?.failed ?? 0).toLocaleString()}
            tone={(job?.failed ?? 0) > 0 ? "warn" : undefined}
          />
        </div>

        {(job?.error_log ?? []).length > 0 && (
          <div className="rounded-md border border-ghw-copper/40 bg-ghw-copper/5 p-3 space-y-1">
            <p className="text-xs font-semibold text-ghw-copper flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Recent errors
            </p>
            <ul className="text-[11px] space-y-0.5 text-muted-foreground">
              {(job?.error_log ?? []).slice(-5).map((line, i) => (
                <li key={i} className="font-mono truncate">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          {running ? (
            <Button
              variant="outline"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              Cancel Import
            </Button>
          ) : (
            <Button variant="outline" onClick={onStartOver}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Import Another
            </Button>
          )}
          {done && (
            <Button asChild>
              <Link href="/clients">View Imported Clients</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
