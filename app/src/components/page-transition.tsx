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
        className="px-4 md:px-6 py-6 md:py-8 min-h-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
