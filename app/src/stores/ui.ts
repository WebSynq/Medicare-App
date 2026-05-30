/**
 * UI store — sidebar collapsed state, mobile drawer, command
 * palette open. Anything that's not page-data and not auth.
 *
 * Sidebar state is persisted (agents tend to pick "open" or
 * "collapsed" and stick with it across sessions). The mobile
 * drawer + command palette are per-session — no point persisting.
 */

"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface UIState {
  /** Desktop sidebar — true = full width, false = icon-only rail. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  /** Mobile drawer — overlays the page on screens <md. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;

  /** Command palette (Ctrl/Cmd+K). */
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),

      mobileNavOpen: false,
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),

      commandPaletteOpen: false,
      setCommandPaletteOpen: (commandPaletteOpen) =>
        set({ commandPaletteOpen }),
    }),
    {
      name: "ghw:ui",
      storage: createJSONStorage(() => localStorage),
      // Only persist sidebar — drawer + palette are ephemeral.
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen }),
    },
  ),
);

export const selectSidebarOpen = (s: UIState): boolean => s.sidebarOpen;
