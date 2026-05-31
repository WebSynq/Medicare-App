import { RoutePlaceholder } from "@/components/route-placeholder";

export default function Page() {
  return (
    <RoutePlaceholder
      title="Notifications"
      description="In-app notification panel — port of the CRA NotificationPanel + unread-badge polling. Lands in its own workstream."
      backendRoute="GET /api/notifications"
    />
  );
}
