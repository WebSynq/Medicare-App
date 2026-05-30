import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Applications"
      backendRoute="POST /api/applications/*"
    />
  );
}
