/**
 * Public booking endpoints — /api/book/*
 *
 * No auth. CSRF-exempt. The public booking page calls these from
 * anonymous browsers. NEVER include the impersonation header.
 */

import axios from "axios";

import type { WorkingHours } from "@/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

/** Dedicated client for the public booking surface so we don't ride
 *  on the credentialed `api` instance — anonymous browsers shouldn't
 *  carry the session cookie out to /book endpoints. */
const publicApi = axios.create({
  baseURL: BACKEND_URL,
  withCredentials: false,
  headers: { "Content-Type": "application/json" },
});

export interface BookingPageInfo {
  agent_name: string; // first name only
  bio: string | null;
  meeting_types: string[];
  appointment_duration: number;
  advance_notice_hours: number;
  booking_window_days: number;
  working_hours: WorkingHours;
}

export async function getInfo(slug: string): Promise<BookingPageInfo> {
  const { data } = await publicApi.get<BookingPageInfo>(
    `/api/book/${slug}/info`,
  );
  return data;
}

export interface BookingToken {
  token: string;
  expires_in: number;
}

export async function getToken(slug: string): Promise<BookingToken> {
  const { data } = await publicApi.get<BookingToken>(
    `/api/book/${slug}/token`,
  );
  return data;
}

export interface BookingSlots {
  date: string;
  slots: string[];
  duration?: number;
  reason?: string;
}

export async function getSlots(
  slug: string,
  date: string,
): Promise<BookingSlots> {
  const { data } = await publicApi.get<BookingSlots>(
    `/api/book/${slug}/slots`,
    { params: { date } },
  );
  return data;
}

export type BookingReason =
  | "New to Medicare"
  | "Plan Review"
  | "Turning 65 Soon"
  | "Employer to Medicare"
  | "Cost & Coverage Questions"
  | "Other";

export interface PublicBookingPayload {
  client_name: string;
  client_phone: string;
  client_email?: string;
  date: string;
  time: string;
  meeting_type: "phone" | "video";
  booking_reason: BookingReason;
  notes?: string;
  token: string;
  /** Hidden honeypot — must stay empty. */
  website?: string;
}

export interface BookingConfirmation {
  status: "confirmed";
  message: string;
  date: string;
  time: string;
  meeting_type: "phone" | "video";
}

export async function createBooking(
  slug: string,
  payload: PublicBookingPayload,
): Promise<BookingConfirmation> {
  const { data } = await publicApi.post<BookingConfirmation>(
    `/api/book/${slug}`,
    payload,
  );
  return data;
}
