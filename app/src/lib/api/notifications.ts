/**
 * Notifications endpoints — /api/notifications/*
 * Backend lives in backend/notifications_router.py. Shapes are
 * authoritative; field renames here will break the SPA panel.
 */

import { api } from "./client";

export type NotificationType =
  | "renewal_due"
  | "birthday_window"
  | "stale_lead"
  | "appointment_today"
  | "lead_transferred"
  | "commission_gap";

export interface Notification {
  notification_id: string;
  agent_id: string;
  agency_id: string;
  type: NotificationType | string;
  title: string;
  body: string | null;
  link: string | null;
  target_id: string | null;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
}

export interface ListResponse {
  notifications: Notification[];
  total: number;
}

export interface UnreadCountResponse {
  count: number;
}

export async function listNotifications(): Promise<ListResponse> {
  const { data } = await api.get<ListResponse>("/api/notifications");
  return data;
}

export async function getUnreadCount(): Promise<UnreadCountResponse> {
  const { data } = await api.get<UnreadCountResponse>(
    "/api/notifications/unread-count",
  );
  return data;
}

export async function markAllRead(): Promise<void> {
  await api.patch("/api/notifications/read-all");
}

export async function markRead(id: string): Promise<void> {
  await api.patch(`/api/notifications/${id}/read`);
}

export async function deleteNotification(id: string): Promise<void> {
  await api.delete(`/api/notifications/${id}`);
}
