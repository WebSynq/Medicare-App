import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Clients"
      backendRoute="GET /api/leads"
    />
  );
}
