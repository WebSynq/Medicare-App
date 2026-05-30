import { PageTabs } from "@/components/layout/page-tabs";

const tabs = [
  { label: "Upcoming", href: "/appointments", exact: true },
  { label: "Calendar", href: "/appointments/calendar" },
  { label: "Round Robin", href: "/appointments/round-robin" },
];

export default function AppointmentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Appointments"
        description="Your booked meetings, calendar, and round-robin distribution"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
