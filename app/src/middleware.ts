/**
 * Next.js edge middleware — route gating.
 *
 * Reads the httpOnly `ghw_access_token` cookie set by the FastAPI
 * backend's login endpoints. Middleware doesn't (and can't)
 * validate the JWT — that's the backend's job. It only checks
 * presence and routes accordingly:
 *
 *   - Public routes        → always allowed
 *   - /                    → / if anon → /login; if authed → /today
 *   - All other routes     → require the cookie; otherwise
 *                            redirect to /login?redirect_to=<path>
 *
 * The cookie's HttpOnly flag means the SPA itself can't read it
 * via document.cookie — middleware is the only place we can do a
 * presence check before render. Components that need the actual
 * user object call /api/auth/me on mount and mirror it into
 * useAuthStore.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ACCESS_TOKEN_COOKIE = "ghw_access_token";

/** Routes that don't require auth. Patterns match against the
 *  pathname only — query strings are stripped before comparison. */
const PUBLIC_PATH_EXACT = new Set<string>([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/auth/magic",
  "/mfa",
  "/privacy",
  "/security",
]);

/** Prefixes that route to public pages (dynamic segments). */
const PUBLIC_PATH_PREFIXES: readonly string[] = [
  "/book/", // public booking page — /book/[slug]
  "/soa/", // public SOA signing — /soa/[token]
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATH_EXACT.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(ACCESS_TOKEN_COOKIE);

  // Root — bounce to /today or /login based on session.
  if (pathname === "/") {
    const target = hasSession ? "/today" : "/login";
    return NextResponse.redirect(new URL(target, request.url));
  }

  // Public route — allow through unconditionally. Authed users
  // hitting /login still get the form; the login page itself can
  // detect a stale session and redirect to /today client-side
  // after a /me probe.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Protected route — require the session cookie.
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    // Preserve the deep link so we can bounce back after login.
    loginUrl.searchParams.set("redirect_to", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

/** Match everything except Next internals + static assets. The
 *  negative lookahead pattern is the canonical exclusion list
 *  recommended in the Next.js middleware docs. */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
