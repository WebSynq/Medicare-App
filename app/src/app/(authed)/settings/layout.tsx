"use client";

import * as React from "react";

import { PageTabs } from "@/components/layout/page-tabs";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";

const BASE_TABS = [
  { label: "Profile", href: "/settings", exact: true },
  { label: "Booking", href: "/settings/booking" },
  { label: "Integrations", href: "/settings/integrations" },
  { label: "Calendars", href: "/settings/calendars" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Security", href: "/settings/security" },
];

const AGENCY_TAB = { label: "Agency", href: "/settings/agency" };

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const tabs = React.useMemo(
    () => (hasAgencyScope ? [...BASE_TABS, AGENCY_TAB] : BASE_TABS),
    [hasAgencyScope],
  );

  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Settings"
        description="Your profile, public booking page, security, and integrations"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
