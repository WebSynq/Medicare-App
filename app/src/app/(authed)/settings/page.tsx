import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Settings"
      backendRoute="GET /api/profile/me"
    />
  );
}
