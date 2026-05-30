"use client";

/**
 * CFO chat — Bedrock-backed streaming assistant scoped to agency
 * financial data. Renders as a right-side panel; parent toggles
 * visibility via the `open` prop.
 *
 * Ports `frontend/src/components/CFOChat.jsx` 1:1 in behavior:
 * fetch + ReadableStream over SSE, abortable per send, markdown-
 * rendered assistant turns, last-10-turn history sent on each
 * request to give the model conversational continuity without
 * unbounded growth.
 */

import * as React from "react";
import { Brain, Send, Trash2, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { cfo } from "@/lib/api";
import type { CFOChatTurn } from "@/lib/api/cfo";

const MAX_HISTORY = 10;

const SUGGESTED: readonly string[] = [
  "What's our collection rate this month?",
  "Which carrier owes us the most?",
  "Show me commission gaps by agent",
  "Why is revenue down from last month?",
  "Generate a Q1 summary",
];

interface CFOChatProps {
  open: boolean;
  onClose: () => void;
}

export function CFOChat({ open, onClose }: CFOChatProps) {
  const [messages, setMessages] = React.useState<CFOChatTurn[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [streamingText, setStreamingText] = React.useState("");
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new content or visibility change.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, open]);

  // Abort any in-flight stream on unmount so React's strict-mode
  // double-mount in dev doesn't leak a hanging fetch.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const visibleHistory = React.useMemo(
    () => messages.slice(-MAX_HISTORY),
    [messages],
  );

  const handleClear = React.useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreamingText("");
    setStreaming(false);
  }, []);

  const send = React.useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || streaming) return;

      const next: CFOChatTurn[] = [...messages, { role: "user", content: text }];
      setMessages(next);
      setInput("");
      setStreaming(true);
      setStreamingText("");

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = "";
      let errored = false;

      try {
        await cfo.streamCFOChat({
          message: text,
          history: next.slice(-MAX_HISTORY - 1, -1),
          signal: controller.signal,
          onText: (chunk) => {
            accumulated += chunk;
            setStreamingText(accumulated);
          },
          onError: (msg) => {
            errored = true;
            toast.error(msg);
          },
        });

        if (accumulated.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulated },
          ]);
        } else if (!errored) {
          toast.error("CFO assistant returned no response");
        }
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e?.name !== "AbortError") {
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Mobile backdrop — desktop layout already shrinks the parent. */}
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
        <div className="flex items-center justify-between px-3 py-3 text-primary-foreground bg-gradient-to-br from-background-elevated to-elevated">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-md grid place-items-center flex-shrink-0 bg-primary text-primary-foreground">
              <Brain className="w-4 h-4" />
            </div>
            <div className="leading-tight min-w-0">
              <div className="text-sm font-semibold truncate text-foreground font-display">
                GHW CFO Assistant
              </div>
              <Badge
                variant="outline"
                className="text-[9px] uppercase border-border text-muted-foreground mt-0.5"
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
              className="p-1.5 text-foreground-muted hover:text-foreground disabled:opacity-40"
              aria-label="Clear conversation"
              data-testid="cfo-chat-clear"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-foreground-muted hover:text-foreground"
              aria-label="Close CFO panel"
              data-testid="cfo-chat-close"
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
                onClick={() => void send(q)}
                className="w-full text-left px-3 py-2 rounded-lg border border-border hover:border-primary/60 hover:bg-secondary/40 text-sm transition-colors"
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
                className="ml-auto max-w-[85%] rounded-2xl px-3 py-2 bg-primary text-primary-foreground"
              >
                {m.content}
              </div>
            ) : (
              <div
                key={i}
                className="mr-auto max-w-[92%] rounded-2xl px-3 py-2 bg-secondary text-foreground"
              >
                <ReactMarkdown
                  components={{
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
                      <a className="text-primary underline" target="_blank" rel="noreferrer" {...p} />
                    ),
                    hr: (p) => <hr className="my-2 border-t border-border" {...p} />,
                    blockquote: (p) => (
                      <blockquote
                        className="border-l-2 border-primary/50 pl-2 italic text-foreground/80 my-2"
                        {...p}
                      />
                    ),
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
                    code: ({ className, children, ...rest }) => {
                      const isInline = !className?.includes("language-");
                      return isInline ? (
                        <code
                          className="font-mono bg-secondary px-1 py-0.5 rounded text-[12px]"
                          {...rest}
                        >
                          {children}
                        </code>
                      ) : (
                        <pre className="bg-secondary p-2 rounded text-[12px] overflow-x-auto my-2">
                          <code className={className} {...rest}>
                            {children}
                          </code>
                        </pre>
                      );
                    },
                  }}
                >
                  {m.content}
                </ReactMarkdown>
              </div>
            ),
          )}
          {streaming ? (
            streamingText ? (
              <div className="mr-auto max-w-[92%] rounded-2xl px-3 py-2 bg-secondary text-foreground">
                <ReactMarkdown>{streamingText}</ReactMarkdown>
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
              className={cn(
                "flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm",
                "focus:outline-none focus:border-primary min-h-[40px] max-h-32",
              )}
              data-testid="cfo-chat-input"
              disabled={streaming}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={streaming || !input.trim()}
              aria-label="Send"
              className="rounded-lg p-2 bg-primary text-primary-foreground disabled:opacity-40"
              data-testid="cfo-chat-send"
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
