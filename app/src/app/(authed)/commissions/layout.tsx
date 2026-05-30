import { PageTabs } from "@/components/layout/page-tabs";

const tabs = [
  { label: "Overview", href: "/commissions", exact: true },
  { label: "Leaderboard", href: "/commissions/leaderboard" },
  { label: "Calculator", href: "/commissions/calculator" },
  { label: "Statements", href: "/commissions/statements" },
];

export default function CommissionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Commissions"
        description="Track your earnings, run the calculator, and upload statements"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
