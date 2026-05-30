/**
 * Barrel for the API namespace.
 *
 *   import { auth, leads, appointments, calendars } from "@/lib/api";
 *
 *   const user = await auth.getMe();
 *   const list = await leads.listLeads({ status: "new" });
 *
 * The shared axios client + isApiError helper are re-exported at
 * the top level for convenience.
 */

import * as authNs from "./auth";
import * as calendarsNs from "./calendars";
import * as leadsNs from "./leads";
import * as appointmentsNs from "./appointments";
import * as todayNs from "./today";

export { api, isApiError, setImpersonationAgentId, getImpersonationAgentId } from "./client";

export const auth = authNs;
export const calendars = calendarsNs;
export const leads = leadsNs;
export const appointments = appointmentsNs;
export const today = todayNs;
