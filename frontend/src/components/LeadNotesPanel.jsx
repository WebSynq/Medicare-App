import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  StickyNote,
  Phone,
  Mail,
  CheckSquare,
  Trash2,
  Calendar as CalendarIcon,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { api, auth } from "@/lib/api";

const NOTE_TYPE_OPTIONS = [
  { value: "note", label: "Note", icon: StickyNote },
  { value: "call", label: "Call", icon: Phone },
  { value: "email", label: "Email", icon: Mail },
];
const NOTE_TYPE_ICON = Object.fromEntries(
  NOTE_TYPE_OPTIONS.map((o) => [o.value, o.icon]),
);

function relTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function isOverdue(dueIso) {
  if (!dueIso) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueIso + "T00:00:00").getTime() < today.getTime();
}

/**
 * Notes + Tasks panel pinned to a single lead. Used full-size in
 * ClientProfile and in a condensed form (compact prop) by the
 * Pipeline card sheet.
 */
export default function LeadNotesPanel({ leadId, compact = false, onChange }) {
  const me = auth.getUser();
  const isPrivileged =
    me?.role === "admin" ||
    me?.role === "compliance" ||
    me?.role === "coach" ||
    me?.role === "accounting" ||
    me?.role === "client_success";

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftType, setDraftType] = useState("note");
  const [saving, setSaving] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDue, setTaskDue] = useState("");

  const load = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    try {
      const res = await api.get("/notes", { params: { lead_id: leadId } });
      setItems(res.data?.notes || []);
    } catch (err) {
      // 403 on a non-owned lead is fine — just show empty.
      if (err?.response?.status !== 403) {
        toast.error(err?.response?.data?.detail || "Failed to load notes");
      }
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  const notes = useMemo(() => items.filter((i) => !i.is_task), [items]);
  const tasksOpen = useMemo(
    () => items.filter((i) => i.is_task && !i.task_completed)
      .sort((a, b) => (a.task_due_date || "").localeCompare(b.task_due_date || "")),
    [items],
  );
  const tasksDone = useMemo(
    () => items.filter((i) => i.is_task && i.task_completed)
      .sort((a, b) => (b.task_completed_at || "").localeCompare(a.task_completed_at || "")),
    [items],
  );

  async function addNote() {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      const res = await api.post("/notes", {
        lead_id: leadId,
        content,
        type: draftType,
      });
      setItems((prev) => [res.data, ...prev]);
      setDraft("");
      toast.success(`${draftType[0].toUpperCase()}${draftType.slice(1)} logged`);
      onChange?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function addTask() {
    const content = taskDraft.trim();
    if (!content) {
      toast.error("Task content required");
      return;
    }
    if (!taskDue) {
      toast.error("Pick a due date");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post("/notes", {
        lead_id: leadId,
        content,
        type: "task",
        is_task: true,
        task_due_date: taskDue,
      });
      setItems((prev) => [res.data, ...prev]);
      setTaskDraft("");
      setTaskDue("");
      toast.success("Task added");
      onChange?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to add task");
    } finally {
      setSaving(false);
    }
  }

  async function completeTask(note) {
    // Optimistic flip.
    setItems((prev) =>
      prev.map((n) =>
        n.note_id === note.note_id
          ? { ...n, task_completed: true, task_completed_at: new Date().toISOString() }
          : n,
      ),
    );
    try {
      const res = await api.patch(`/notes/${note.note_id}/complete`);
      setItems((prev) =>
        prev.map((n) => (n.note_id === note.note_id ? res.data : n)),
      );
      onChange?.();
    } catch (err) {
      // Revert.
      setItems((prev) =>
        prev.map((n) =>
          n.note_id === note.note_id
            ? { ...n, task_completed: false, task_completed_at: null }
            : n,
        ),
      );
      toast.error(err?.response?.data?.detail || "Failed to complete task");
    }
  }

  async function deleteNote(note) {
    if (!window.confirm("Delete this note?")) return;
    try {
      await api.delete(`/notes/${note.note_id}`);
      setItems((prev) => prev.filter((n) => n.note_id !== note.note_id));
      toast.success("Note deleted");
      onChange?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to delete");
    }
  }

  function canDelete(note) {
    return isPrivileged || note.agent_id === me?.id;
  }

  // Condensed variant for the Pipeline card sheet — only shows the
  // last 2 notes and a quick-add input.
  if (compact) {
    const last2 = notes.slice(0, 2);
    return (
      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Recent Notes
        </div>
        {loading ? (
          <div className="h-10 rounded bg-secondary/40 animate-pulse" />
        ) : last2.length === 0 ? (
          <p className="text-xs text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {last2.map((n) => {
              const Icon = NOTE_TYPE_ICON[n.type] || StickyNote;
              return (
                <li
                  key={n.note_id}
                  className="text-xs flex items-start gap-2 p-2 rounded bg-secondary/40"
                >
                  <Icon className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2">{n.content}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {n.agent_name || "—"} · {relTime(n.created_at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a quick note…"
            className="text-xs"
            data-testid="notes-quick-add"
          />
          <Button
            type="button"
            size="sm"
            onClick={addNote}
            disabled={saving || !draft.trim()}
            className="bg-[#e85d2f] hover:bg-[#c84416] flex-shrink-0"
          >
            + Add
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Tabs defaultValue="notes" className="w-full">
      <TabsList>
        <TabsTrigger value="notes" data-testid="lead-notes-tab">
          Notes ({notes.length})
        </TabsTrigger>
        <TabsTrigger value="tasks" data-testid="lead-tasks-tab">
          Tasks ({tasksOpen.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="notes" className="mt-3 space-y-3">
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Select value={draftType} onValueChange={setDraftType}>
                <SelectTrigger className="w-32 h-9 text-xs" data-testid="notes-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-[11px] text-muted-foreground">
                Log a {draftType}. Max 1000 characters.
              </div>
            </div>
            <Textarea
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1000}
              placeholder={`What happened on this ${draftType}?`}
              data-testid="notes-content"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {draft.length}/1000
              </span>
              <Button
                type="button"
                size="sm"
                onClick={addNote}
                disabled={saving || !draft.trim()}
                className="bg-[#e85d2f] hover:bg-[#c84416]"
                data-testid="notes-add"
              >
                Add {draftType}
              </Button>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <div className="h-20 rounded bg-secondary/40 animate-pulse" />
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No notes yet. Log your first call, email, or note above.
          </p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => {
              const Icon = NOTE_TYPE_ICON[n.type] || StickyNote;
              return (
                <li
                  key={n.note_id}
                  className="rounded-md border border-border bg-surface p-3"
                  data-testid={`note-row-${n.note_id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <Icon className="w-3.5 h-3.5 mt-0.5 text-[#e85d2f] flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm whitespace-pre-wrap break-words">
                          {n.content}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1">
                          {n.agent_name || "—"} · {relTime(n.created_at)} ·{" "}
                          <span className="capitalize">{n.type}</span>
                        </div>
                      </div>
                    </div>
                    {canDelete(n) && (
                      <button
                        type="button"
                        onClick={() => deleteNote(n)}
                        className="text-muted-foreground hover:text-rose-600 p-1 flex-shrink-0"
                        aria-label="Delete note"
                        data-testid={`note-delete-${n.note_id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="tasks" className="mt-3 space-y-3">
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-2">
              <Input
                value={taskDraft}
                onChange={(e) => setTaskDraft(e.target.value)}
                maxLength={1000}
                placeholder="Follow up call, send Plan G quote, etc."
                data-testid="tasks-content"
              />
              <Input
                type="date"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
                data-testid="tasks-due-date"
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={addTask}
                disabled={saving || !taskDraft.trim() || !taskDue}
                className="bg-[#e85d2f] hover:bg-[#c84416]"
                data-testid="tasks-add"
              >
                Add Task
              </Button>
            </div>
          </CardContent>
        </Card>

        {tasksOpen.length === 0 && tasksDone.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <>
            {tasksOpen.length > 0 && (
              <ul className="space-y-2">
                {tasksOpen.map((t) => (
                  <li
                    key={t.note_id}
                    className="rounded-md border border-border bg-surface p-3 flex items-start gap-2"
                    data-testid={`task-row-${t.note_id}`}
                  >
                    <button
                      type="button"
                      onClick={() => completeTask(t)}
                      className="mt-0.5 flex-shrink-0"
                      aria-label="Complete task"
                      data-testid={`task-complete-${t.note_id}`}
                    >
                      <CheckSquare className="w-4 h-4 text-muted-foreground hover:text-[#e85d2f]" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{t.content}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1">
                          <CalendarIcon className="w-3 h-3" />
                          Due {t.task_due_date}
                        </span>
                        {isOverdue(t.task_due_date) && (
                          <Badge className="rounded-full bg-rose-100 text-rose-900 border-0 text-[10px]">
                            <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
                            Overdue
                          </Badge>
                        )}
                        <span>{t.agent_name || "—"}</span>
                      </div>
                    </div>
                    {canDelete(t) && (
                      <button
                        type="button"
                        onClick={() => deleteNote(t)}
                        className="text-muted-foreground hover:text-rose-600 p-1 flex-shrink-0"
                        aria-label="Delete task"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {tasksDone.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground py-2">
                  Completed ({tasksDone.length})
                </summary>
                <ul className="space-y-1.5 mt-2">
                  {tasksDone.map((t) => (
                    <li
                      key={t.note_id}
                      className="text-xs text-muted-foreground flex items-center gap-2 px-2 py-1.5 rounded bg-secondary/40"
                    >
                      <CheckSquare className="w-3 h-3 text-emerald-600 flex-shrink-0" />
                      <span className="line-through truncate flex-1">{t.content}</span>
                      <span className="text-[10px] flex-shrink-0">
                        {relTime(t.task_completed_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}
