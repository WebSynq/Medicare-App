import type { Metadata } from "next";
import localFont from "next/font/local";
import { DM_Sans, JetBrains_Mono, Syne } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";

import { ThemeProvider } from "@/components/providers/theme-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthBootstrap } from "@/components/providers/auth-bootstrap";
import { cn } from "@/lib/utils";

import "./globals.css";

// ── Fonts ──────────────────────────────────────────────────────────────────
// Geist (sans + mono) stays as a local fallback so the first paint never
// shows fallback metrics. Syne / DM Sans / JetBrains Mono are pulled from
// Google with display: "swap" — they upgrade the type system in-place once
// the network round-trip lands.
const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-dm-sans",
  display: "swap",
});
const syne = Syne({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-syne",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GHW Portal",
    template: "%s · GHW Portal",
  },
  description:
    "Gruening Health & Wealth — agent portal for Medicare intake, SOA capture, and commission tracking.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning on <html> — next-themes flips the
    // `dark` class before React hydrates, which would otherwise be
    // flagged as a hydration mismatch.
    //
    // We also stamp `dark` directly in the SSR markup so the first
    // paint is the dark palette (no flash of light theme) even
    // before next-themes hydrates. Since enableSystem=false +
    // defaultTheme="dark" in the provider, this matches what
    // next-themes would land on anyway.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "dark",
        geistSans.variable,
        geistMono.variable,
        dmSans.variable,
        syne.variable,
        jetbrainsMono.variable,
      )}
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider>
          <QueryProvider>
            <AuthBootstrap />
            {children}
            <Toaster richColors closeButton position="top-right" />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
