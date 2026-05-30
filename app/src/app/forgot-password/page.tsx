import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Forgot Password"
      backendRoute="POST /api/profile/forgot-password"
    />
  );
}
