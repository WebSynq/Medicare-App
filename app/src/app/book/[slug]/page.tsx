import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Public Booking"
      backendRoute="GET /api/book/:slug/info"
    />
  );
}
