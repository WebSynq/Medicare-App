import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  MessageCircle,
  X as XIcon,
  Send,
  Trash2,
  Sparkles,
  Minus,
} from "lucide-react";
import { toast } from "sonner";
import { API, auth, getImpersonatedAgentId } from "@/lib/api";

const STORAGE_OPEN_KEY = "ghw_chat_open";
const MAX_HISTORY = 10;
const CSRF_COOKIE = "ghw_csrf_token";

function readCsrfCookie() {
  const match = document.cookie
    .split("; ")
    .find((r) => r.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

function pageSlug(pathname) {
  if (!pathname) return "unknown";
  const cleaned = pathname.replace(/^\/+|\/+$/g, "");
  return cleaned ? cleaned.split("/")[0] : "home";
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2" aria-label="Assistant typing">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "120ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "240ms" }} />
    </div>
  );
}

export default function ChatWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  // Hide the widget on public/auth chrome where we don't have a user.
  const user = auth.getUser();
  const isAuthRoute =
    location.pathname === "/" ||
    location.pathname.startsWith("/login") ||
    location.pathname.startsWith("/register") ||
    location.pathname.startsWith("/security") ||
    location.pathname.startsWith("/privacy") ||
    location.pathname.startsWith("/intake");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN_KEY, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open]);

  // Auto-scroll the messages area on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, open]);

  // Cancel any in-flight stream when the widget unmounts.
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const visibleHistory = useMemo(() => messages.slice(-MAX_HISTORY), [messages]);

  const handleClear = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setMessages([]);
    setStreamingText("");
    setStreaming(false);
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setStreaming(true);
    setStreamingText("");

    const controller = new AbortController();
    abortRef.current = controller;

    const csrf = readCsrfCookie();
    const impersonated = getImpersonatedAgentId();
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (impersonated) headers["X-Agent-ID"] = impersonated;

    try {
      const resp = await fetch(`${API}/chat`, {
        method: "POST",
        credentials: "include",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          conversation_history: next.slice(-MAX_HISTORY - 1, -1),
          context: {
            page: pageSlug(location.pathname),
            agent_name: user?.agent_name || user?.full_name || "",
            client_name: "",
          },
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

      // Standard SSE parse: split on blank lines, each frame is one or more
      // `data: ...` lines. We tolerate `[DONE]` (a sentinel string) and
      // ignore anything that isn't valid JSON.
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
              toast.error(obj.content || "Assistant unavailable");
            }
          } catch {
            // ignore non-JSON SSE frames
          }
        }
      }

      if (accumulated.trim()) {
        setMessages((prev) => [...prev, { role: "assistant", content: accumulated }]);
      } else if (!errored) {
        toast.error("Assistant returned no response");
      }
    } catch (e) {
      if (e?.name !== "AbortError") {
        // Surface the actual error to the browser console — invisible to
        // end users, but the only signal a developer gets if Bedrock /
        // CSRF / CORS misbehaves in prod.
        // eslint-disable-next-line no-console
        console.error("Chat request failed", e);
        toast.error(e?.message || "Chat request failed");
      }
    } finally {
      setStreaming(false);
      setStreamingText("");
      abortRef.current = null;
    }
  }, [input, messages, streaming, location.pathname, user]);

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (isAuthRoute || !user) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open GHW Assistant"
        data-testid="chat-widget-toggle"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full text-white shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
        style={{
          background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
        }}
      >
        <MessageCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-5 right-5 z-40 w-[340px] h-[480px] rounded-xl shadow-2xl border border-border bg-background flex flex-col overflow-hidden"
      data-testid="chat-widget-panel"
      role="dialog"
      aria-label="GHW Assistant"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 text-white"
        style={{ background: "linear-gradient(135deg, #0d1b2a 0%, #1e2d3d 100%)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-6 h-6 rounded-md grid place-items-center flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)" }}
            aria-hidden="true"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-sm font-semibold truncate" style={{ fontFamily: "Outfit" }}>
              GHW Assistant
            </div>
            <div className="text-[10px] text-white/55 -mt-0.5">Bedrock AI</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleClear}
            disabled={messages.length === 0 && !streaming}
            className="p-1 text-white/70 hover:text-white disabled:opacity-40"
            aria-label="Clear conversation"
            data-testid="chat-clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 text-white/70 hover:text-white"
            aria-label="Minimize chat"
            data-testid="chat-minimize"
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-secondary/30"
      >
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-muted-foreground text-center mt-6 px-4">
            Ask anything about Medicare products, CMS rules, or carriers.
            I'll never quote premiums or access client PHI.
          </div>
        )}
        {visibleHistory.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={
                m.role === "user"
                  ? "max-w-[80%] rounded-2xl rounded-br-md px-3 py-2 text-sm text-white whitespace-pre-wrap break-words"
                  : "max-w-[85%] rounded-2xl rounded-bl-md px-3 py-2 text-sm bg-white border border-border whitespace-pre-wrap break-words"
              }
              style={
                m.role === "user"
                  ? { background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)" }
                  : undefined
              }
              data-testid={`chat-msg-${m.role}`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[85%] rounded-2xl rounded-bl-md px-3 py-2 text-sm bg-white border border-border whitespace-pre-wrap break-words"
              data-testid="chat-msg-streaming"
            >
              {streamingText || <TypingDots />}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background px-3 py-2">
        <div className="flex items-end gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question…"
            disabled={streaming}
            data-testid="chat-input"
            className="flex-1 h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-[#e85d2f]/40 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={streaming || !input.trim()}
            aria-label="Send message"
            data-testid="chat-send"
            className="h-9 w-9 rounded-md text-white flex items-center justify-center disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)" }}
          >
            {streaming ? (
              <XIcon
                className="w-4 h-4"
                onClick={() => abortRef.current?.abort()}
              />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Press Enter to send
        </div>
      </div>
    </div>
  );
}
