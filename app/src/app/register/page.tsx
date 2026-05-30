import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Create Account"
      backendRoute="POST /api/auth/register"
    />
  );
}
