import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search as SearchIcon,
  Users2,
  Calendar as CalendarIcon,
  StickyNote,
  Loader2,
  Command as CommandIcon,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const TYPE_META = {
  lead: { label: "Leads", icon: Users2 },
  appointment: { label: "Appointments", icon: CalendarIcon },
  note: { label: "Notes", icon: StickyNote },
};

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 300;

/**
 * Cmd/Ctrl+K global search dialog. Mounts once at the app root
 * (AppLayout) and is opened via the SearchTrigger button in the
 * sidebar / mobile top bar, or via the keyboard shortcut.
 */
export default function GlobalSearch({ open, onOpenChange }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const reqCounterRef = useRef(0);

  // Reset state on close so re-opening doesn't show stale results.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  // Debounced query → /api/search.
  useEffect(() => {
    if (!open) return undefined;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const myReq = ++reqCounterRef.current;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const res = await api.get("/search", {
          params: { q: trimmed, limit: 20 },
        });
        // Drop stale responses if a later keystroke already fired.
        if (myReq !== reqCounterRef.current) return;
        setResults(res.data?.results || []);
      } catch (err) {
        if (myReq !== reqCounterRef.current) return;
        const status = err?.response?.status;
        // 429 = rate limit. 400 = too short (shouldn't fire since we
        // gate locally, but defensive).
        setError(
          status === 429
            ? "Search rate limit reached — try again in a minute."
            : err?.response?.data?.detail || "Search failed",
        );
        setResults([]);
      } finally {
        if (myReq === reqCounterRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, open]);

  // Group results by type for the section headers.
  const grouped = results.reduce((acc, r) => {
    (acc[r.type] = acc[r.type] || []).push(r);
    return acc;
  }, {});

  function handlePick(result) {
    onOpenChange(false);
    if (result?.url) {
      navigate(result.url);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl p-0 gap-0 overflow-hidden"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // Autofocus the input ourselves so the dialog's default
          // first-focusable-element logic doesn't land on the close
          // button.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Global search</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <SearchIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search leads, appointments, notes…"
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 px-0 h-9 text-sm"
            data-testid="global-search-input"
            autoFocus
          />
          {loading && (
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-secondary text-[10px] text-muted-foreground font-mono">
            ESC
          </kbd>
        </div>
        <div
          className="max-h-[400px] overflow-y-auto"
          data-testid="global-search-results"
        >
          {query.trim().length > 0 && query.trim().length < MIN_QUERY_LEN && (
            <p className="text-xs text-muted-foreground p-4 text-center">
              Type at least {MIN_QUERY_LEN} characters to search.
            </p>
          )}
          {error && (
            <p className="text-xs text-rose-700 p-4 text-center">{error}</p>
          )}
          {!error &&
            !loading &&
            query.trim().length >= MIN_QUERY_LEN &&
            results.length === 0 && (
              <p className="text-xs text-muted-foreground p-4 text-center">
                No results for "{query.trim()}".
              </p>
            )}
          {Object.entries(TYPE_META).map(([type, meta]) => {
            const rows = grouped[type];
            if (!rows || rows.length === 0) return null;
            const Icon = meta.icon;
            return (
              <div key={type} className="py-1">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground bg-secondary/40">
                  {meta.label} ({rows.length})
                </div>
                <ul>
                  {rows.map((r) => (
                    <li key={`${r.type}-${r.id}`}>
                      <button
                        type="button"
                        onClick={() => handlePick(r)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-secondary/60 transition-colors"
                        data-testid={`global-search-result-${r.type}-${r.id}`}
                      >
                        <Icon className="w-4 h-4 text-[#e85d2f] flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">
                            {r.title}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {r.subtitle}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        {query.trim().length === 0 && !loading && (
          <div className="px-3 py-3 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between">
            <span>Search across the whole platform.</span>
            <span className="hidden sm:inline-flex items-center gap-1">
              <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">
                <CommandIcon className="w-2.5 h-2.5" />K
              </kbd>
              to open
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
