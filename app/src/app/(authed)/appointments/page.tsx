import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Appointments"
      backendRoute="GET /api/appointments"
    />
  );
}
