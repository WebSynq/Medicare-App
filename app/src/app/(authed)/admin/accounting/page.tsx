import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Accounting"
      backendRoute="GET /api/accounting/*"
    />
  );
}
