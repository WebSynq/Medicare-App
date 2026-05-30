"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  AppSidebar,
  AppSidebarMobile,
  MobileTopBar,
} from "@/components/sidebar/app-sidebar";
import { PageTransition } from "@/components/page-transition";
import { useAuthStore } from "@/stores";

/**
 * Authenticated layout group.
 *
 * Routes inside (authed)/ get the sidebar + main content area.
 * The middleware already enforces cookie presence; this layer
 * additionally watches the store status — if the in-process
 * /me probe came back 401 (status flipped to "anon") we redirect
 * to /login. Covers the case where the cookie is present but
 * the session is server-side invalidated mid-tab.
 */
export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);

  React.useEffect(() => {
    if (status === "anon") {
      router.replace("/login");
    }
  }, [status, router]);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppSidebar />
      <AppSidebarMobile />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileTopBar />
        <main className="flex-1 overflow-y-auto bg-background">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}
