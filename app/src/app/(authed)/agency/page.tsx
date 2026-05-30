import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Agency"
      backendRoute="GET /api/agency/stats"
    />
  );
}
