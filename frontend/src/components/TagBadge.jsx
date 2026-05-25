import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { api } from "@/lib/api";

// ── Tag library cache ───────────────────────────────────────────────────────
// Module-level cache shared across pages so navigating between the list
// and a client detail doesn't refetch on every mount. Cleared by
// `refreshTagLibrary()` after a custom-tag create so the dropdown
// rebuilds with the new entry.
let _libraryPromise = null;
let _library = null;
const _subscribers = new Set();

function _notify() {
  for (const fn of _subscribers) fn();
}

async function _loadOnce() {
  if (_library) return _library;
  if (!_libraryPromise) {
    _libraryPromise = api
      .get("/tags")
      .then((res) => {
        _library = res?.data?.tags || [];
        return _library;
      })
      .catch(() => {
        // Don't cache a failure — next call retries.
        _libraryPromise = null;
        return [];
      });
  }
  return _libraryPromise;
}

export function refreshTagLibrary() {
  _library = null;
  _libraryPromise = null;
  _notify();
}

export function useTagLibrary() {
  const [tags, setTags] = useState(_library || []);
  const [loading, setLoading] = useState(_library === null);

  useEffect(() => {
    let alive = true;
    const sub = async () => {
      setLoading(true);
      const lib = await _loadOnce();
      if (alive) {
        setTags(lib);
        setLoading(false);
      }
    };
    sub();
    _subscribers.add(sub);
    return () => {
      alive = false;
      _subscribers.delete(sub);
    };
  }, []);

  // name → tag for O(1) lookup when rendering badges from a name list.
  const byName = useMemo(() => {
    const map = new Map();
    for (const t of tags) map.set(t.name, t);
    return map;
  }, [tags]);

  return { tags, byName, loading };
}

// ── Color helpers ───────────────────────────────────────────────────────────
// Compute a readable foreground given the background hex. Tags are agency-
// editable so we can't preselect a palette — derive contrast at render time.
function _hexToRgb(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return [128, 128, 128];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function _readableFg(bgHex) {
  const [r, g, b] = _hexToRgb(bgHex);
  // YIQ luminance — light backgrounds get dark text, dark backgrounds get
  // white text. Threshold chosen so the orange / amber tags read dark.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160 ? "#1f2937" : "#ffffff";
}

// ── Single badge ────────────────────────────────────────────────────────────
export default function TagBadge({
  tag,            // optional library tag object {name,label,color}
  name,           // fallback when only the name is known (e.g. orphaned tag)
  onRemove,       // when set, renders an X click target inside the pill
  size = "sm",
  testId,
}) {
  const display = tag?.label || name || tag?.name || "";
  const bg = tag?.color || "#94a3b8";
  const fg = _readableFg(bg);
  const sizeClasses =
    size === "xs"
      ? "text-[10px] px-1.5 py-0 h-5"
      : "text-[11px] px-2 py-0.5 h-6";

  return (
    <Badge
      className={`rounded-full border-0 ${sizeClasses} font-medium inline-flex items-center gap-1`}
      style={{ backgroundColor: bg, color: fg }}
      data-testid={testId}
      title={display}
    >
      <span className="truncate max-w-[160px]">{display}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove tag ${display}`}
          className="ml-0.5 hover:opacity-70 leading-none"
          data-testid={testId ? `${testId}-remove` : undefined}
        >
          <X className="w-3 h-3" />
        </button>
      ) : null}
    </Badge>
  );
}

// ── Inline row of badges + "+N more" overflow indicator ─────────────────────
export function TagBadgeRow({ names, max = 3, testId }) {
  const { byName } = useTagLibrary();
  if (!names || names.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }
  const visible = names.slice(0, max);
  const overflow = names.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={testId}>
      {visible.map((n) => (
        <TagBadge key={n} tag={byName.get(n)} name={n} size="xs" />
      ))}
      {overflow > 0 ? (
        <span
          className="text-[10px] text-muted-foreground px-1"
          title={names.slice(max).join(", ")}
          data-testid={testId ? `${testId}-overflow` : undefined}
        >
          +{overflow} more
        </span>
      ) : null}
    </div>
  );
}

// ── Add-tag popover combobox (typeahead over the library) ───────────────────
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export function AddTagPopover({
  appliedNames = [],
  onPick,
  triggerLabel = "Add Tag",
  triggerTestId = "add-tag-btn",
}) {
  const { tags, loading } = useTagLibrary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const applied = new Set(appliedNames);
    return tags
      .filter((t) => !applied.has(t.name))
      .filter((t) =>
        !q
          ? true
          : t.label.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [tags, query, appliedNames]);

  const pick = useCallback(
    async (t) => {
      setOpen(false);
      setQuery("");
      if (onPick) await onPick(t);
    },
    [onPick],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          data-testid={triggerTestId}
        >
          <Plus className="w-3 h-3 mr-1" /> {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-2"
        data-testid="add-tag-popover"
      >
        <Input
          autoFocus
          placeholder="Search tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 text-xs mb-2"
          data-testid="add-tag-search"
        />
        <div className="max-h-64 overflow-y-auto space-y-1">
          {loading && (
            <div className="text-xs text-muted-foreground px-2 py-1">
              Loading…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-1">
              No matches.
            </div>
          )}
          {filtered.map((t) => (
            <button
              type="button"
              key={t.name}
              onClick={() => pick(t)}
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-secondary text-left"
              data-testid={`add-tag-option-${t.name}`}
            >
              <TagBadge tag={t} size="xs" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {t.category}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Multi-select dropdown for filtering the list ────────────────────────────
export function TagFilterPopover({
  selected = [],
  onChange,
  triggerTestId = "tag-filter-btn",
}) {
  const { tags, loading } = useTagLibrary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tags
      .filter((t) =>
        !q
          ? true
          : t.label.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [tags, query]);

  function toggle(name) {
    const next = new Set(selectedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange?.(Array.from(next));
  }

  function clearAll() {
    onChange?.([]);
  }

  const count = selected.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-10 text-xs"
          data-testid={triggerTestId}
        >
          Tags{count > 0 ? ` (${count})` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-2"
        data-testid="tag-filter-popover"
      >
        <div className="flex items-center gap-2 mb-2">
          <Input
            autoFocus
            placeholder="Search tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 text-xs"
            data-testid="tag-filter-search"
          />
          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-[10px] px-2"
              onClick={clearAll}
              data-testid="tag-filter-clear"
            >
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {loading && (
            <div className="text-xs text-muted-foreground px-2 py-1">
              Loading…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-1">
              No tags found.
            </div>
          )}
          {filtered.map((t) => {
            const checked = selectedSet.has(t.name);
            return (
              <button
                type="button"
                key={t.name}
                onClick={() => toggle(t.name)}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-secondary text-left ${
                  checked ? "bg-secondary" : ""
                }`}
                data-testid={`tag-filter-option-${t.name}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="pointer-events-none"
                  />
                  <TagBadge tag={t} size="xs" />
                </div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {t.category}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
