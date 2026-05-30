import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Renewals"
      backendRoute="GET /api/renewals/alerts"
    />
  );
}
