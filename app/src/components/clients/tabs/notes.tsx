"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CheckSquare,
  Loader2,
  Send,
  StickyNote,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isApiError, notes as notesApi } from "@/lib/api";
import type { NoteKind, NoteRecord } from "@/types";

export function NotesTab({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["notes", { lead_id: leadId }],
    queryFn: () => notesApi.listByLead(leadId),
  });

  const [kind, setKind] = React.useState<NoteKind>("note");
  const [body, setBody] = React.useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      notesApi.createNote({
        lead_id: leadId,
        kind,
        body: body.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes", { lead_id: leadId }] });
      setBody("");
      toast.success(kind === "task" ? "Task added." : "Note added.");
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't save.";
      toast.error(msg);
    },
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => notesApi.completeTask(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", { lead_id: leadId }] }),
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't mark complete."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => notesApi.deleteNote(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", { lead_id: leadId }] }),
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't delete."),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    createMutation.mutate();
  }

  const records = query.data?.notes ?? [];

  return (
    <div className="space-y-4">
      <Card className="border-border/70">
        <CardContent className="p-4 md:p-5">
          <form onSubmit={submit} className="space-y-3">
            <Tabs value={kind} onValueChange={(v) => setKind(v as NoteKind)}>
              <TabsList>
                <TabsTrigger value="note">
                  <StickyNote className="h-3.5 w-3.5 mr-1.5" />
                  Note
                </TabsTrigger>
                <TabsTrigger value="task">
                  <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
                  Task
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                kind === "task"
                  ? "What needs to happen next? (e.g. Call back Tuesday to confirm PCP)"
                  : "Drop a note about this client…"
              }
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={!body.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                )}
                {kind === "task" ? "Add task" : "Add note"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <StickyNote className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">No notes or tasks yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Use the form above to log what just happened or what comes next.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-2">
          {records.map((rec) => (
            <NoteRow
              key={rec.id}
              record={rec}
              onComplete={() => completeMutation.mutate(rec.id)}
              onDelete={() => deleteMutation.mutate(rec.id)}
              completing={
                completeMutation.isPending &&
                completeMutation.variables === rec.id
              }
              deleting={
                deleteMutation.isPending &&
                deleteMutation.variables === rec.id
              }
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function NoteRow({
  record,
  onComplete,
  onDelete,
  completing,
  deleting,
}: {
  record: NoteRecord;
  onComplete: () => void;
  onDelete: () => void;
  completing: boolean;
  deleting: boolean;
}) {
  const isTask = record.kind === "task";
  const isDone = record.completed;
  return (
    <li>
      <Card
        className={cn(
          "border-l-4",
          isTask
            ? isDone
              ? "border-l-ghw-forest/60 opacity-70"
              : "border-l-ghw-copper"
            : "border-l-border",
        )}
      >
        <CardContent className="p-3 md:p-4">
          <div className="flex items-start gap-3">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase tracking-wider mt-0.5",
                isTask
                  ? "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
                  : "bg-muted text-muted-foreground border-border",
              )}
            >
              {record.kind}
            </Badge>
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  "text-sm whitespace-pre-wrap",
                  isDone ? "line-through text-muted-foreground" : "",
                )}
              >
                {record.body}
              </p>
              <div className="mt-1 text-[10px] text-muted-foreground tabular-nums flex items-center gap-2 flex-wrap">
                <span>
                  {new Date(record.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {isDone ? (
                  <span className="inline-flex items-center gap-1 text-ghw-forest">
                    <CheckCircle2 className="h-3 w-3" />
                    completed
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 flex-shrink-0">
              {isTask && !isDone ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onComplete}
                  disabled={completing}
                  className="h-7 text-[11px]"
                >
                  {completing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                disabled={deleting}
                className="h-7 text-[11px] text-muted-foreground hover:text-destructive"
              >
                {deleting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
