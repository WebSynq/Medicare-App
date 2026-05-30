/**
 * Daily inspirational quote — Quotable.io.
 *
 * Public unauthenticated endpoint. We use a separate fetch (not the
 * shared axios client) so the GHW session cookie is never sent off-
 * domain. Five hardcoded fallback quotes ride along in case the
 * upstream is down or rate-limits.
 */

const QUOTABLE_URL =
  "https://api.quotable.io/random?tags=inspirational";

export interface Quote {
  content: string;
  author: string;
  /** True when this was the upstream API; false when we fell back
   *  to the hardcoded list. UI uses it to label the source. */
  live: boolean;
}

const FALLBACKS: { content: string; author: string }[] = [
  {
    content:
      "Success is not final, failure is not fatal: it is the courage to continue that counts.",
    author: "Winston Churchill",
  },
  {
    content: "The secret of getting ahead is getting started.",
    author: "Mark Twain",
  },
  {
    content: "Don't watch the clock; do what it does. Keep going.",
    author: "Sam Levenson",
  },
  {
    content: "Believe you can and you're halfway there.",
    author: "Theodore Roosevelt",
  },
  {
    content: "It always seems impossible until it's done.",
    author: "Nelson Mandela",
  },
];

function pickFallback(): Quote {
  const idx = Math.floor(Math.random() * FALLBACKS.length);
  const f = FALLBACKS[idx] ?? FALLBACKS[0]!;
  return { content: f.content, author: f.author, live: false };
}

export async function getDailyQuote(): Promise<Quote> {
  try {
    const response = await fetch(QUOTABLE_URL, {
      credentials: "omit",
      // Quotable can hang under load — keep the round-trip bounded so a
      // slow upstream doesn't delay the dashboard render visibly.
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return pickFallback();
    }
    const data: { content?: string; author?: string } = await response.json();
    const content = (data.content ?? "").trim();
    const author = (data.author ?? "").trim();
    if (!content || !author) {
      return pickFallback();
    }
    return { content, author, live: true };
  } catch {
    return pickFallback();
  }
}
