import { createHash } from "node:crypto";

/** Short identifier independent of PostgreSQL's 63-byte identifier limit. */
export const notificationFunctionName = (eventsTable: string): string =>
  `structure_notify_${createHash("sha256").update(eventsTable).digest("hex").slice(0, 24)}`;

/** Trigger names are local to their table; channels use that table's OID. */
export const notificationTriggerName = "structure_events_insert_notify";
