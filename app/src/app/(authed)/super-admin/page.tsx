import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Super Admin"
      backendRoute="GET /api/super-admin/system"
    />
  );
}
