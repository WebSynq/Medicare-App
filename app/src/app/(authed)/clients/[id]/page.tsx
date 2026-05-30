import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Client Profile"
      backendRoute="GET /api/leads/:id"
    />
  );
}
