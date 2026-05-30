"use client";

import * as React from "react";
import {
  Briefcase,
  CalendarDays,
  KeyRound,
  Link2,
  ShieldAlert,
  User as UserIcon,
} from "lucide-react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";
import { ProfileSettingsTab } from "@/components/settings/profile-tab";
import { BookingSettingsTab } from "@/components/settings/booking-tab";
import { SecuritySettingsTab } from "@/components/settings/security-tab";
import { IntegrationsSettingsTab } from "@/components/settings/integrations-tab";
import { CalendarsSettingsTab } from "@/components/settings/calendars-tab";
import { AgencySettingsTab } from "@/components/settings/agency-tab";

export default function SettingsPage() {
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const [tab, setTab] = React.useState("profile");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Profile, booking page, security, integrations, calendars
          {hasAgencyScope ? ", and agency" : ""}.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="profile">
            <UserIcon className="h-3.5 w-3.5 mr-1.5" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="booking">
            <Briefcase className="h-3.5 w-3.5 mr-1.5" />
            Booking page
          </TabsTrigger>
          <TabsTrigger value="security">
            <KeyRound className="h-3.5 w-3.5 mr-1.5" />
            Security
          </TabsTrigger>
          <TabsTrigger value="integrations">
            <Link2 className="h-3.5 w-3.5 mr-1.5" />
            Integrations
          </TabsTrigger>
          <TabsTrigger value="calendars">
            <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
            Calendars
          </TabsTrigger>
          {hasAgencyScope ? (
            <TabsTrigger value="agency">
              <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
              Agency
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          <ProfileSettingsTab />
        </TabsContent>
        <TabsContent value="booking" className="mt-6">
          <BookingSettingsTab />
        </TabsContent>
        <TabsContent value="security" className="mt-6">
          <SecuritySettingsTab />
        </TabsContent>
        <TabsContent value="integrations" className="mt-6">
          <IntegrationsSettingsTab />
        </TabsContent>
        <TabsContent value="calendars" className="mt-6">
          <CalendarsSettingsTab />
        </TabsContent>
        {hasAgencyScope ? (
          <TabsContent value="agency" className="mt-6">
            <AgencySettingsTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
