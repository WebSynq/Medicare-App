import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Send, Trash2, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { API } from "@/lib/api";

const CSRF_COOKIE = "ghw_csrf_token";
const MAX_HISTORY = 10;

function readCsrfCookie() {
  const match = document.cookie
    .split("; ")
    .find((r) => r.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

// Same markdown overrides as the agent chat — slightly larger fonts since
// the CFO panel is wider.
const MD = {
  p: (p) => <p className="mb-2 last:mb-0 leading-snug" {...p} />,
  h1: (p) => <h3 className="text-sm font-semibold mt-2 mb-1" {...p} />,
  h2: (p) => <h3 className="text-sm font-semibold mt-2 mb-1" {...p} />,
  h3: (p) => <h3 className="text-sm font-semibold mt-2 mb-1" {...p} />,
  ul: (p) => <ul className="list-disc ml-5 mb-2 last:mb-0 space-y-0.5" {...p} />,
  ol: (p) => <ol className="list-decimal ml-5 mb-2 last:mb-0 space-y-0.5" {...p} />,
  li: (p) => <li className="leading-snug" {...p} />,
  strong: (p) => <strong className="font-semibold" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  a: (p) => (
    <a className="text-[#e85d2f] underline" target="_blank" rel="noreferrer" {...p} />
  ),
  hr: (p) => <hr className="my-2 border-t border-border" {...p} />,
  blockquote: (p) => (
    <blockquote
      className="border-l-2 border-[#e85d2f]/50 pl-2 italic text-foreground/80 my-2"
      {...p}
    />
  ),
  // Tables — CFO answers often include comparison grids.
  table: (p) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-xs border-collapse" {...p} />
    </div>
  ),
  thead: (p) => <thead className="bg-secondary/60" {...p} />,
  th: (p) => (
    <th className="border border-border px-2 py-1 text-left font-semibold" {...p} />
  ),
  td: (p) => <td className="border border-border px-2 py-1 tabular-nums" {...p} />,
  code: ({ inline, className, children, ...p }) =>
    inline ? (
      <code
        className="font-mono bg-secondary px-1 py-0.5 rounded text-[12px]"
        {...p}
      >
        {children}
      </code>
    ) : (
      <pre className="bg-secondary p-2 rounded text-[12px] overflow-x-auto my-2">
        <code className={className} {...p}>
          {children}
        </code>
      </pre>
    ),
};

const SUGGESTED = [
  "What's our collection rate this month?",
  "Which carrier owes us the most?",
  "Show me commission gaps by agent",
  "Why is revenue down from last month?",
  "Generate a Q1 summary",
];

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" />
      <span
        className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
        style={{ animationDelay: "120ms" }}
      />
      <span
        className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
        style={{ animationDelay: "240ms" }}
      />
    </div>
  );
}

export default function CFOChat({ open, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, open]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const visibleHistory = useMemo(() => messages.slice(-MAX_HISTORY), [messages]);

  const handleClear = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setMessages([]);
    setStreamingText("");
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (overrideText) => {
      const text = (overrideText ?? input).trim();
      if (!text || streaming) return;
      const next = [...messages, { role: "user", content: text }];
      setMessages(next);
      setInput("");
      setStreaming(true);
      setStreamingText("");

      const controller = new AbortController();
      abortRef.current = controller;
      const csrf = readCsrfCookie();
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (csrf) headers["X-CSRF-Token"] = csrf;

      try {
        const resp = await fetch(`${API}/cfo-chat`, {
          method: "POST",
          credentials: "include",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            message: text,
            conversation_history: next.slice(-MAX_HISTORY - 1, -1),
          }),
        });
        if (!resp.ok || !resp.body) {
          const err = await resp.text().catch(() => "");
          throw new Error(err || `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";
        let errored = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data);
              if (obj.type === "text" && obj.content) {
                accumulated += obj.content;
                setStreamingText(accumulated);
              } else if (obj.type === "error") {
                errored = true;
                toast.error(obj.content || "CFO assistant unavailable");
              }
            } catch {
              /* ignore */
            }
          }
        }
        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        } else if (!errored) {
          toast.error("CFO assistant returned no response");
        }
      } catch (e) {
        if (e?.name !== "AbortError") {
          // eslint-disable-next-line no-console
          console.error("CFO chat failed", e);
          toast.error(e?.message || "CFO chat failed");
        }
      } finally {
        setStreaming(false);
        setStreamingText("");
        abortRef.current = null;
      }
    },
    [input, messages, streaming],
  );

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Mobile backdrop — desktop layout already shrinks main content. */}
      <div
        className="fixed inset-0 z-30 bg-black/40 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        data-testid="cfo-chat-panel"
        className="fixed right-0 top-0 bottom-0 z-40 w-full md:w-[400px] bg-background border-l border-border shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-3 text-white"
          style={{
            background: "linear-gradient(135deg, #0d1b2a 0%, #1e2d3d 100%)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-8 h-8 rounded-md grid place-items-center flex-shrink-0"
              style={{
                background:
                  "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              }}
            >
              <Brain className="w-4 h-4" />
            </div>
            <div className="leading-tight min-w-0">
              <div
                className="text-sm font-semibold truncate"
                style={{ fontFamily: "Outfit" }}
              >
                GHW CFO Assistant
              </div>
              <Badge
                variant="outline"
                className="text-[9px] uppercase border-white/30 text-white/70 mt-0.5"
              >
                Powered by AWS Bedrock
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleClear}
              disabled={messages.length === 0 && !streaming}
              className="p-1.5 text-white/70 hover:text-white disabled:opacity-40"
              aria-label="Clear conversation"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-white/70 hover:text-white"
              aria-label="Close CFO panel"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Suggested prompts when empty */}
        {messages.length === 0 && !streaming ? (
          <div className="p-4 space-y-2">
            <div className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              Try asking
            </div>
            {SUGGESTED.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="w-full text-left px-3 py-2 rounded-lg border border-border hover:border-[#e85d2f]/60 hover:bg-secondary/40 text-sm transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 py-3 space-y-2 text-sm"
        >
          {visibleHistory.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[85%] text-white rounded-2xl px-3 py-2"
                style={{
                  background:
                    "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                }}
              >
                {m.content}
              </div>
            ) : (
              <div
                key={i}
                className="mr-auto max-w-[92%] rounded-2xl px-3 py-2 bg-secondary text-foreground"
              >
                <ReactMarkdown components={MD}>{m.content}</ReactMarkdown>
              </div>
            ),
          )}
          {streaming ? (
            streamingText ? (
              <div className="mr-auto max-w-[92%] rounded-2xl px-3 py-2 bg-secondary text-foreground">
                <ReactMarkdown components={MD}>{streamingText}</ReactMarkdown>
              </div>
            ) : (
              <div className="mr-auto max-w-[92%] rounded-2xl bg-secondary">
                <TypingDots />
              </div>
            )
          ) : null}
        </div>

        {/* Input */}
        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Ask about commissions, gaps, carriers…"
              className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-[#e85d2f] min-h-[40px] max-h-32"
              data-testid="cfo-chat-input"
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={streaming || !input.trim()}
              aria-label="Send"
              className="rounded-lg p-2 text-white disabled:opacity-40"
              style={{
                background:
                  "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              }}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mt-2">
            CFO answers reference live agency data. Never reference specific
            client identifiers without verifying compliance.
          </div>
        </div>
      </aside>
    </>
  );
}
