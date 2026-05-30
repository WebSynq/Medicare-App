import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Reset Password"
      backendRoute="POST /api/profile/reset-password"
    />
  );
}
