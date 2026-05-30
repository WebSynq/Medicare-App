"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Thin wrapper around next-themes' provider so consumers don't
 * have to import the v0.4-vs-v0.5 component-prop union directly.
 *
 * GHW defaults:
 *   defaultTheme = "dark"   — the brand is dark gold
 *   attribute    = "class"  — sets `dark` on <html>
 *   enableSystem = false    — explicit theme only; field agents
 *                             on screens in bright daylight need
 *                             a deterministic switch
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
