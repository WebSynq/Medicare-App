import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Birthday Rule"
      backendRoute="GET /api/birthday-rule/alerts"
    />
  );
}
