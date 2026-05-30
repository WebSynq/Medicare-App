import { PageTabs } from "@/components/layout/page-tabs";

const tabs = [
  { label: "Lead Sources", href: "/reports", exact: true },
  { label: "Agent Performance", href: "/reports/agent-performance" },
  { label: "Revenue", href: "/reports/revenue" },
];

export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Reports"
        description="Source attribution, agent production, and revenue trends"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
