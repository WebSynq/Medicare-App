"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/api";
import { useAuthStore, useUIStore } from "@/stores";
import type { UserRole } from "@/types";

import { NAV, NAV_FOOTER, type NavItem } from "./nav-config";

const SIDEBAR_WIDTH = 256;

function canSee(item: NavItem, role: UserRole | null, isSuperAdmin: boolean): boolean {
  if (item.superAdminOnly) return isSuperAdmin;
  if (!item.roles || item.roles.length === 0) return true;
  if (!role) return false;
  if (isSuperAdmin) return true;
  return item.roles.includes(role);
}

function SidebarNavLink({
  href,
  label,
  Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  Icon: NavItem["icon"];
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        // Border-l-2 reserves the gold accent strip slot whether the
        // link is active or not — keeps icons aligned the same column
        // either way (no x-shift on hover/active swap).
        "group flex items-center gap-3 rounded-md pl-3 pr-3 py-2 text-sm transition-colors border-l-2",
        active
          ? "border-primary bg-elevated text-primary"
          : "border-transparent text-foreground-muted hover:bg-elevated hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 flex-shrink-0",
          active ? "text-primary" : "text-foreground-subtle group-hover:text-foreground",
        )}
      />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const role = user?.role ?? null;
  const isSuperAdmin = user?.super_admin ?? false;

  const handleLogout = React.useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      // Ignore — backend may have already invalidated; we still
      // bounce to /login so the user isn't stuck.
    }
    useAuthStore.getState().clear();
    router.push("/login");
    onNavigate?.();
  }, [router, onNavigate]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Brand */}
      <div className="flex h-16 items-center gap-2 border-b border-border px-5">
        <div className="h-8 w-8 rounded-md bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center">
          <span className="text-sm font-bold text-primary font-display">G</span>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-wide font-display">
            GHW Portal
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
            Gruening Health
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        {NAV.map((section) => {
          const items = section.items.filter((item) =>
            canSee(item, role, isSuperAdmin),
          );
          if (items.length === 0) return null;
          return (
            <div key={section.title} className="mb-5">
              <div className="px-3 pb-1 text-xs uppercase tracking-wider text-foreground-subtle font-medium">
                {section.title}
              </div>
              <nav className="space-y-0.5">
                {items.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(item.href + "/");
                  return (
                    <SidebarNavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      Icon={item.icon}
                      active={active}
                      onNavigate={onNavigate}
                    />
                  );
                })}
              </nav>
            </div>
          );
        })}
      </ScrollArea>

      {NAV_FOOTER.length > 0 ? (
        <>
          <Separator className="bg-border" />
          <div className="px-3 py-3 space-y-0.5">
            {NAV_FOOTER.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(item.href + "/");
              return (
                <SidebarNavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  Icon={item.icon}
                  active={active}
                  onNavigate={onNavigate}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <div className="bg-elevated border-t border-border px-3 py-3">
        <div className="px-3 pb-2">
          <div className="text-sm font-medium truncate">
            {user?.full_name ?? user?.email ?? "Loading…"}
          </div>
          <div className="text-[11px] text-foreground-muted truncate capitalize">
            {role ?? "—"}
            {isSuperAdmin ? " · super admin" : ""}
          </div>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start text-foreground-muted hover:text-foreground hover:bg-accent-hover"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** Desktop sidebar — fixed-width column on md+ screens. */
export function AppSidebar() {
  return (
    <aside
      className="hidden md:block bg-background border-r border-border flex-shrink-0"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <SidebarContent />
    </aside>
  );
}

/** Mobile nav — Sheet drawer triggered by the top-bar burger. */
export function AppSidebarMobile() {
  const open = useUIStore((s) => s.mobileNavOpen);
  const setOpen = useUIStore((s) => s.setMobileNavOpen);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        className="p-0 w-72 bg-background text-foreground border-r border-border"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/** Mobile-only top bar with a burger that opens the drawer. */
export function MobileTopBar() {
  const setOpen = useUIStore((s) => s.setMobileNavOpen);
  return (
    <div className="md:hidden flex items-center gap-2 border-b border-border px-4 h-14 bg-background">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <div className="text-sm font-semibold">GHW Portal</div>
    </div>
  );
}
