import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Lead Sources"
      backendRoute="GET /api/dashboard/lead-sources"
    />
  );
}
