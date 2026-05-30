import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Import Leads"
      backendRoute="POST /api/leads/import"
    />
  );
}
