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
import * as dashboardNs from "./dashboard";
import * as auditNs from "./audit";
import * as bookNs from "./book";
import * as quoteNs from "./quote";
import * as accountingNs from "./accounting";
import * as cfoNs from "./cfo";
import * as notificationsNs from "./notifications";

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
export const dashboard = dashboardNs;
export const audit = auditNs;
export const book = bookNs;
export const quote = quoteNs;
export const accounting = accountingNs;
export const cfo = cfoNs;
export const notifications = notificationsNs;
