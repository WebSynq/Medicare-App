import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Owner Settings"
      backendRoute="GET /api/agency/settings"
    />
  );
}
