import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Data Import"
      backendRoute="POST /api/admin/import/*"
    />
  );
}
