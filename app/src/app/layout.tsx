import type { Metadata } from "next";
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import "./globals.css";

// Geist isn't on Google Fonts — Vercel ships it as a separate `geist`
// npm package OR as bundled .woff files (the create-next-app default,
// which is what we use here). shadcn init tries to import Geist from
// next/font/google and breaks the build; the canonical path is
// next/font/local against the .woff files in this directory.
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

export const metadata: Metadata = {
  title: "GHW Portal",
  description: "Gruening Health & Wealth — agent portal.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("font-sans", geistSans.variable, geistMono.variable)}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
