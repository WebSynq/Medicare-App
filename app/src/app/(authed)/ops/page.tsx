import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Ops Console"
      backendRoute="GET /api/ops/health"
    />
  );
}
