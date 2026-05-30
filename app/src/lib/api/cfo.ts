/**
 * CFO chat client — POST /api/cfo-chat (SSE).
 *
 * Streams `data: {"type":"text"|"error","content":"…"}` lines
 * separated by blank lines, terminated by `data: [DONE]`. The
 * shared axios instance can't do SSE, so we drop down to fetch +
 * ReadableStream — mirrors the CRA CFOChat.jsx pattern.
 *
 * The browser's `withCredentials` mechanism (httpOnly auth cookie
 * + JS-readable CSRF cookie) works on plain fetch via
 * `credentials: "include"`; we hand-attach the CSRF header off
 * `js-cookie` since axios's interceptor isn't in the path.
 */

import Cookies from "js-cookie";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
const CSRF_COOKIE = "ghw_csrf_token";

export interface CFOChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CFOChatStreamOptions {
  message: string;
  history?: CFOChatTurn[];
  signal?: AbortSignal;
  /** Called once per `data: {type:"text"}` chunk with the new
   *  delta. The full accumulated text is yours to maintain. */
  onText: (chunk: string) => void;
  /** Called once per `data: {type:"error"}` chunk. Treated as a
   *  recoverable warning by the caller (the panel surfaces a toast
   *  but doesn't tear down the conversation). */
  onError?: (message: string) => void;
}

/**
 * Stream a chat turn. Resolves when the SSE connection closes
 * cleanly (after `[DONE]`). Rejects on HTTP non-2xx or a fetch
 * error other than user abort.
 */
export async function streamCFOChat(opts: CFOChatStreamOptions): Promise<void> {
  const csrf = Cookies.get(CSRF_COOKIE);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (csrf) headers["X-CSRF-Token"] = csrf;

  const resp = await fetch(`${BACKEND_URL}/api/cfo-chat`, {
    method: "POST",
    credentials: "include",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      message: opts.message,
      conversation_history: opts.history ?? [],
    }),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "");
    throw new Error(errText || `HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Read until upstream closes. Each chunk is decoded incrementally
  // and split on newlines — SSE frames are `data: <json>\n\n`.
  // Multi-frame chunks are common; partial frames at the end of a
  // chunk get held in `buffer` until the next read completes them.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload) as {
          type?: string;
          content?: string;
        };
        if (obj.type === "text" && obj.content) {
          opts.onText(obj.content);
        } else if (obj.type === "error") {
          opts.onError?.(obj.content || "CFO assistant returned an error");
        }
      } catch {
        // Bad/incomplete JSON line — ignore. Most often a benign
        // keep-alive comment line ("\n") that slipped through the
        // startsWith("data:") guard.
      }
    }
  }
}
