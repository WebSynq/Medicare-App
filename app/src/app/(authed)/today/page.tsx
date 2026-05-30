import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Today"
      backendRoute="GET /api/today/actions"
    />
  );
}
