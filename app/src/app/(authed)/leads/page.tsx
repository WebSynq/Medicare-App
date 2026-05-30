import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Leads"
      backendRoute="GET /api/leads (alias)"
    />
  );
}
