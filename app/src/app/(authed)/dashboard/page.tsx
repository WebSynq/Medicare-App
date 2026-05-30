import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Dashboard"
      backendRoute="GET /api/dashboard/stats"
    />
  );
}
