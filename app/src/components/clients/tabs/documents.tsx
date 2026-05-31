"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Inbox, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { documents as documentsApi, isApiError } from "@/lib/api";
import type { DocumentType, LeadDocument } from "@/types";

const DOC_TYPES: { value: DocumentType; label: string }[] = [
  { value: "medicare_card", label: "Medicare Card" },
  { value: "drivers_license", label: "Driver's License" },
  { value: "state_id", label: "State ID" },
  { value: "ssn_card", label: "SSN Card" },
  { value: "application_pdf", label: "Application PDF" },
  { value: "soa", label: "SOA" },
  { value: "eft_authorization", label: "EFT Authorization" },
  { value: "other", label: "Other" },
];

const DOC_TYPE_LABEL: Record<DocumentType, string> = DOC_TYPES.reduce(
  (acc, t) => ({ ...acc, [t.value]: t.label }),
  {} as Record<DocumentType, string>,
);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function DocumentsTab({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["documents", { lead_id: leadId }],
    queryFn: () => documentsApi.listByLead(leadId),
  });

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [docType, setDocType] = React.useState<DocumentType>("other");

  const uploadMutation = useMutation({
    mutationFn: (file: File) => documentsApi.uploadDocument(leadId, file, docType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents", { lead_id: leadId }] });
      toast.success("Uploaded.");
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Upload failed.";
      toast.error(msg);
    },
  });

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadMutation.mutate(file);
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      <Card className="border-border/70">
        <CardContent className="p-4 md:p-5 flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground mr-1" />
          <h3 className="text-sm font-semibold mr-auto">Documents</h3>
          <Select
            value={docType}
            onValueChange={(v) => setDocType(v as DocumentType)}
          >
            <SelectTrigger className="w-[170px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOC_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5 mr-1.5" />
            )}
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={onFilePicked}
          />
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyDocs error message="Couldn't load documents." />
      ) : (query.data?.documents ?? []).length === 0 ? (
        <EmptyDocs />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40">
              <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
                <th className="text-left px-3 py-2">File</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">Type</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">Size</th>
                <th className="text-left px-3 py-2">Uploaded</th>
                <th className="text-right px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.documents ?? []).map((doc) => (
                <DocumentRow key={doc.id} doc={doc} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function DocumentRow({ doc }: { doc: LeadDocument }) {
  return (
    <tr className="border-b border-border/60 hover:bg-secondary/40 transition-colors">
      <td className="px-3 py-3">
        <div className="font-medium text-sm truncate max-w-[260px]">
          {doc.filename}
        </div>
        <div className="text-[11px] text-muted-foreground truncate md:hidden">
          {DOC_TYPE_LABEL[doc.doc_type]} · {formatBytes(doc.size_bytes)}
        </div>
      </td>
      <td className="px-3 py-3 hidden md:table-cell">
        <Badge variant="outline" className="text-[10px] capitalize">
          {DOC_TYPE_LABEL[doc.doc_type]}
        </Badge>
      </td>
      <td className="px-3 py-3 hidden md:table-cell text-xs text-muted-foreground tabular-nums">
        {formatBytes(doc.size_bytes)}
      </td>
      <td className="px-3 py-3 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {formatDate(doc.uploaded_at)}
      </td>
      <td className="px-3 py-3 text-right">
        <Button asChild size="sm" variant="outline" className="h-8 text-xs">
          <a href={documentsApi.downloadUrl(doc.id)} download>
            <Download className="h-3 w-3 mr-1" />
            <span className="hidden sm:inline">Download</span>
          </a>
        </Button>
      </td>
    </tr>
  );
}

function EmptyDocs({ error, message }: { error?: boolean; message?: string }) {
  return (
    <Card>
      <CardContent
        className={cn(
          "p-10 text-center",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Inbox className="h-10 w-10 mx-auto mb-3" />
        <p className="font-medium text-sm">
          {message ?? "No documents uploaded yet."}
        </p>
        {!error ? (
          <p className="text-xs mt-1">
            Use the upload button above to attach Medicare cards, IDs,
            applications, and EFT forms.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
