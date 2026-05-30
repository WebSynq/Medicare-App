import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // GHW brand colors — semantic aliases for the gold/copper/forest
        // accents the legacy CRM used in inline styles. Kept separate
        // from the shadcn tokens so theme-toggling the surface palette
        // doesn't accidentally shift brand identity.
        ghw: {
          gold: "hsl(38 65% 52%)",
          copper: "hsl(18 50% 45%)",
          forest: "hsl(140 35% 32%)",
          cream: "hsl(38 25% 92%)",
          charcoal: "hsl(30 8% 12%)",
        },
        // GHW design-system vocabulary v2. These aliases point at the
        // same HSL variables that back the shadcn tokens (card / muted-
        // foreground / secondary / accent), so `bg-surface` and
        // `bg-card` are interchangeable. Lets new components reach for
        // semantic names without forcing a refactor of the shadcn
        // primitives. Keep both families in sync when adding tokens.
        surface: "hsl(var(--surface))",
        elevated: "hsl(var(--elevated))",
        "foreground-muted": "hsl(var(--foreground-muted))",
        "foreground-subtle": "hsl(var(--foreground-subtle))",
        "accent-hover": "hsl(var(--accent-hover))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        // GHW v2 type system — loaded via next/font/google in
        // app/layout.tsx and exposed as CSS variables. Geist still
        // ships locally as a fallback (small woff payload, no FOUT
        // window).
        //   sans     — DM Sans for body / UI
        //   display  — Syne for headlines (futurist serifed sans)
        //   mono     — JetBrains Mono for code / tabular fields
        sans: [
          "var(--font-dm-sans)",
          "var(--font-geist-sans)",
          "system-ui",
          "sans-serif",
        ],
        display: [
          "var(--font-syne)",
          "var(--font-dm-sans)",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "var(--font-jetbrains-mono)",
          "var(--font-geist-mono)",
          "ui-monospace",
          "monospace",
        ],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // Used by Sonner toast and shadcn dialog overlays — fades the
        // backdrop in instead of a hard flip.
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 200ms ease-out",
        "fade-out": "fade-out 150ms ease-in",
      },
      boxShadow: {
        // GHW-flavored soft glow on focused gold elements. Use with
        // `shadow-gold-glow` on focus rings around primary buttons.
        "gold-glow":
          "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--primary) / 0.5)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
