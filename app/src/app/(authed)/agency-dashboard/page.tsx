import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Agency Dashboard"
      backendRoute="GET /api/agency-dashboard/*"
    />
  );
}
