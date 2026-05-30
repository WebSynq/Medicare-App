import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Agents"
      backendRoute="GET /api/agents"
    />
  );
}
