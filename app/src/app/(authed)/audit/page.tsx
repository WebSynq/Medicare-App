import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Audit Log"
      backendRoute="GET /api/audit"
    />
  );
}
