import { env } from "cloudflare:workers";
import type { GoogleCalendarEvent } from "../../src/services/googleCalendar";
import { createTestAccount, createTestUser, type TestAccount } from "./fixtures";

// Builders for singleEvents=false LIST items, shaped like the 2026-11-10
// spike's responses (see the design spec's observed-behaviour table).

export const TZ = "Australia/Brisbane";
export const WEEKLY = ["RRULE:FREQ=WEEKLY;BYDAY=TU"];
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

// Tuesday 2026-11-24 09:00 Brisbane, as a UTC instant.
export const SERIES_START_UTC = "2026-11-23T23:00:00.000Z";

export function weeklySeries(id: string, overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: "Team sync",
    transparency: "opaque",
    recurrence: WEEKLY,
    start: { dateTime: "2026-11-24T09:00:00+10:00", timeZone: TZ },
    end: { dateTime: "2026-11-24T10:00:00+10:00", timeZone: TZ },
    ...overrides,
  };
}

// Google's instance id suffix: the original start in UTC, basic format.
export function suffixFor(utcIso: string): string {
  return `_${utcIso.replace(/\.\d{3}/, "").replace(/[-:]/g, "")}`;
}

// The UTC original start of a weekly series' nth occurrence (0 = the first).
export function occurrence(n: number, firstUtc = SERIES_START_UTC): string {
  return new Date(Date.parse(firstUtc) + n * WEEK_MS).toISOString();
}

// An instance of `seriesId` originally at `originalUtc`, moved `shiftHours` later.
export function movedInstance(
  seriesId: string,
  originalUtc: string,
  shiftHours = 5,
  overrides: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  const startMs = Date.parse(originalUtc) + shiftHours * HOUR_MS;
  return {
    id: `${seriesId}${suffixFor(originalUtc)}`,
    recurringEventId: seriesId,
    status: "confirmed",
    summary: "Team sync",
    transparency: "opaque",
    originalStartTime: { dateTime: originalUtc, timeZone: TZ },
    start: { dateTime: new Date(startMs).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(startMs + HOUR_MS).toISOString(), timeZone: TZ },
    ...overrides,
  };
}

// A cancelled instance carries only these fields (Google's docs).
export function cancelledInstance(seriesId: string, originalUtc: string): GoogleCalendarEvent {
  return {
    id: `${seriesId}${suffixFor(originalUtc)}`,
    recurringEventId: seriesId,
    status: "cancelled",
    originalStartTime: { dateTime: originalUtc, timeZone: TZ },
  };
}

export function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * HOUR_MS).toISOString();
}

export interface SeriesSetup {
  userId: string;
  primary: TestAccount;
  biz: TestAccount;
  side: TestAccount;
}

// biz is the source in most tests; its targets are primary and side.
export async function seriesSetup(): Promise<SeriesSetup> {
  const userId = await createTestUser();
  const primary = await createTestAccount(userId, "primary", { email: "me@example.com", accessToken: "tok-primary" });
  const biz = await createTestAccount(userId, "secondary", {
    email: "biz@example.com",
    tag: "business",
    accessToken: "tok-biz",
  });
  const side = await createTestAccount(userId, "secondary", {
    email: "side@example.com",
    tag: "side_hustle",
    accessToken: "tok-side",
  });
  return { userId, primary, biz, side };
}

export async function lastSyncLog(userId: string): Promise<{ status: string; message: string | null } | null> {
  return env.DB.prepare("SELECT status, message FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ status: string; message: string | null }>();
}

export async function queuedCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
