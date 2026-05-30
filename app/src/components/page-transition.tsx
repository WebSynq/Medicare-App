"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Page transition wrapper used inside the (authed) layout.
 *
 * Each route change rerenders the inner motion.div keyed by pathname,
 * so AnimatePresence runs the exit/enter pair: 8px upward slide + fade
 * over 0.3s. Reduced-motion users get a snap (Framer respects the
 * prefers-reduced-motion media query out of the box).
 *
 * No padding here — section layouts (clients/, appointments/, etc.)
 * render a full-bleed PageTabs strip at the top and a padded inner
 * content area below; non-section pages own their own padding inline.
 * That way a full-bleed tab bar can stretch edge-to-edge without
 * fighting an outer padding box.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="min-h-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
