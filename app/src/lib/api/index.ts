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
import * as cnaNs from "./cna";
import * as documentsNs from "./documents";
import * as soaNs from "./soa";
import * as policiesNs from "./policies";
import * as notesNs from "./notes";
import * as commissionsNs from "./commissions";
import * as profileNs from "./profile";
import * as ghlNs from "./ghl";
import * as agencyNs from "./agency";
import * as applicationsNs from "./applications";
import * as opsNs from "./ops";
import * as superAdminNs from "./super-admin";

export { api, isApiError, setImpersonationAgentId, getImpersonationAgentId } from "./client";

export const auth = authNs;
export const calendars = calendarsNs;
export const leads = leadsNs;
export const appointments = appointmentsNs;
export const today = todayNs;
export const cna = cnaNs;
export const documents = documentsNs;
export const soa = soaNs;
export const policies = policiesNs;
export const notes = notesNs;
export const commissions = commissionsNs;
export const profile = profileNs;
export const ghl = ghlNs;
export const agency = agencyNs;
export const applications = applicationsNs;
export const ops = opsNs;
export const superAdmin = superAdminNs;
