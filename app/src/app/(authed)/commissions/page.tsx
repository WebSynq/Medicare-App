import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Commissions"
      backendRoute="GET /api/commissions/*"
    />
  );
}
