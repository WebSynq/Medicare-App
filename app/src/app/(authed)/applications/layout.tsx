import { PageTabs } from "@/components/layout/page-tabs";

const tabs = [
  { label: "New Application", href: "/applications", exact: true },
  { label: "History", href: "/applications/history" },
];

export default function ApplicationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Applications"
        description="Submit a new carrier application or browse past submissions"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
