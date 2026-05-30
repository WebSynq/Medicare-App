import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Calendar"
      backendRoute="GET /api/appointments"
    />
  );
}
