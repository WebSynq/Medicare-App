import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Leaderboard"
      backendRoute="GET /api/leaderboard"
    />
  );
}
