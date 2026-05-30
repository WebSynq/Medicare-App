import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Sign SOA"
      backendRoute="GET /api/soa/public/:token"
    />
  );
}
