import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Admin Commissions"
      backendRoute="GET /api/admin/commissions"
    />
  );
}
