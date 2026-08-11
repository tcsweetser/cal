# Goal
Build an open-source, edge-deployed Calendar Replication & Anti-Double-Booking System on Cloudflare Workers (using Hono, Cloudflare KV, Cloudflare D1, and Cron Triggers) with Google Calendar API integration via Google SSO logins.

# Objective & Core Business Logic
Maintain accurate cross-calendar availability across multiple Google accounts (Business, Personal, Side-Hustles) to prevent double-bookings while preserving event privacy across different contexts.

## Roles & Tags
- **`primary`** — exactly one per user. The main calendar and the Google account used to log into the dashboard.
- **`secondary`** — at least one required. Every secondary account carries exactly one required `tag`: `business`, `side_hustle`, or `personal`. The tag is a **dashboard label only** — it never changes sync behavior or replicated event titles (all secondary accounts sync identically; this preserves the privacy goal, since a tag value never leaks into what another calendar sees).

## Synchronization Rules & Topology
Single-hop fan-out only — every account that should see a native (human-authored) event receives it directly, never through an intermediary:
1. **Secondary -> Primary**: every secondary account's opaque events replicate onto Primary as **"Busy"** (no private descriptions/attendees/locations).
2. **Primary -> every Secondary**: Primary's own opaque events replicate onto every secondary account as **"Personal Time"**.
3. **Secondary -> every other Secondary**: each secondary account's opaque events replicate onto every *other* secondary account as **"Busy"**.
4. **Availability & Filtering Rules**:
   - Synchronize only opaque/busy events (`transparency !== 'transparent'`).
   - Honor all-day events vs. timed events properly (preserving timezones).
   - Real-time deletion propagation: When a source event is deleted or cancelled, its corresponding replicated event(s) on target calendars must be automatically removed.
   - Transparency-flip propagation: an event edited from `opaque` to `transparent` is treated identically to a cancellation — its replica(s) are removed, not left stale.

# Essential Security & Open Source Rules

## 1. Zero Secrets in Repository (Open-Source Ready)
- NO API keys, client secrets, session keys, or tokens must ever be hardcoded or checked into Git.
- **Local Dev**: Use `.dev.vars` (must be added to `.gitignore`).
- **Production**: Access secrets strictly via `c.env` bindings populated via `wrangler secret put` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`).
- Provide a clean `.env.example` file and strict `.gitignore` covering `.dev.vars`, `.wrangler/`, node_modules, and build outputs.

## 2. Authentication & Access Control (Primary Account SSO)
- Access to the application dashboard and management system must be secured via Google SSO logins restricted to the **Primary Account owner**.
- Middleware validates that only authenticated sessions matching the Primary Google account can access admin routes and configure sync rules.

## 3. Storage Architecture (Cloudflare KV + D1)
- **Cloudflare KV (`TOKEN_STORE`)**: Securely stores encrypted OAuth refresh tokens, access tokens, and token expiration timestamps indexed by user/account ID.
- **Cloudflare D1 (`DB`)**: Stores structural metadata: user profiles, linked accounts (`role`: `primary`/`secondary`; secondary accounts also require `tag`: `business`/`side_hustle`/`personal`), sync rules, and event ID translation mappings (`source_event_id` <-> `target_event_id`, one row per source/target pair — a single native event can map to multiple targets).

## 4. Loop Prevention (CRITICAL)
- Replicated events must NOT be relayed further (preventing infinite recursion **and** duplicate delivery). The topology above is single-hop fan-out only — every account that should see a native event already receives it directly — so the rule is a blanket one: a replica is never itself used as a relay source.
  - (This was tightened from an earlier per-target "skip only if writing back to the originating account" rule, which was correct for an earlier 3-tier hub topology but was found to cause duplicate deliveries once every secondary account became a sync source under the finalized 2-role model — see `plan.md` §2 for the full trace.)
- **Mechanism**: tag every replica with provenance metadata, and never treat a tagged event as a relay source.
  - Attach custom extended metadata to every event created by this system using Google Calendar API's `extendedProperties.private`:
    ```json
    {
      "syncEngine": "cf-cal-replication",
      "originAccountId": "<ORIGINAL_SOURCE_ACCOUNT_ID>",
      "originEventId": "<ORIGINAL_SOURCE_EVENT_ID>",
      "syncGroupId": "<USER_ID>"
    }
    ```
  - **Loop guard**: when fetching a source account's events to decide what to relay, skip any event where `extendedProperties?.private?.syncEngine === "cf-cal-replication"`. Only native events are ever relayed.
  - **Origin is preserved across edits**: `originAccountId`/`originEventId` are set once at first `POST`, from the native source event, and every subsequent `PATCH` to that replica (from an edit at the origin) must re-send the same values unchanged — provenance for the dashboard/logs and for the deletion-cascade lookup below.
  - **Transparency-flip = removal**: if a previously-synced event is edited from `opaque` to `transparent`, treat it identically to `status === 'cancelled'` — delete the downstream replica(s) via the existing event-mapping lookup rather than leaving them stale.

## 5. Cron Job Schedule (10-Minute Intervals)
- Cron trigger configured in `wrangler.jsonc` (`cron = ["*/10 * * * *"]`) to trigger the worker every 10 minutes.
- Cron handler pulls incremental deltas (`syncToken`) for all configured calendars and processes updates.

## 6. Future AI Integration Hook (Extensible Architecture)
- Design a modular service interface `AICalendarAssistantService` (e.g. prepare hooks for Cloudflare Workers AI / LLMs).
- Future capabilities will allow the AI agent to:
  1. Detect overlapping/clashing meeting requests.
  2. Intelligently propose rescheduled slots or generate automated rejection draft responses for clashing invitations.

# Step-by-Step Implementation Instructions for Claude Code

### Step 1: Repository & Wrangler Setup
- Initialize a TypeScript Cloudflare Worker project using `wrangler`.
- Write `wrangler.jsonc` specifying:
  - D1 Database Binding (`DB`)
  - KV Namespace Binding (`TOKEN_STORE`)
  - Cron Trigger (`triggers = { crons = ["*/10 * * * *"] }`)
- Write `.gitignore` and `.env.example` ensuring 100% open-source safety.

### Step 2: Google SSO & KV Token Storage Engine
- Implement Google OAuth 2.0 PKCE flow (`/auth/login`, `/auth/callback`, `/auth/connect-account`).
- Restrict dashboard access to the Primary Account email address.
- Build `TokenManager` class to read/write access & refresh tokens to Cloudflare KV (`TOKEN_STORE`), handling transparent token refreshing.

### Step 3: Core Replication Engine (`src/services/syncEngine.ts`)
- Implement bidirectional event sync dispatcher based on configured topology rules.
- Add `fetchIncrementalEvents()` using Google Calendar API `syncToken` for ultra-fast delta fetching.
- Implement event transformation logic (role only — `tag` never affects this):
  - Primary target <- Secondary source -> Title = "Busy"
  - Secondary target (every secondary) <- Primary source -> Title = "Personal Time"
  - Secondary target (every *other* secondary) <- Secondary source -> Title = "Busy"
- Include strict check for `extendedProperties.private.syncEngine === "cf-cal-replication"` to exclude replicas from being used as relay sources (see §4).

### Step 4: Scheduled Cron Execution (`export default { scheduled }`)
- Implement `scheduled` handler executing every 10 minutes.
- Iterate over active calendar sync mappings, fetch updates, upsert/delete events across calendars, and persist new `syncToken` values in D1.

### Step 5: Dashboard UI & AI Assistant Placeholder
- Build clean Hono JSX dashboard routes:
  - `/dashboard`: Primary Google SSO login & connected secondary accounts.
  - `/dashboard/mappings`: Assign role (`primary`, exactly one / `secondary`, at least one) and, for secondary accounts, a required `tag` (`business`/`side_hustle`/`personal`) — a dashboard label only, not a per-tag event title.
  - `/dashboard/logs`: Real-time sync execution logs & manual "Run Sync Now" button.
- Create stub `src/services/aiAssistantService.ts` defining standard interfaces for future AI conflict resolution features.

# Deliverables
1. Complete, production-ready TypeScript code in `src/`.
2. D1 SQL migration file (`migrations/0001_initial_schema.sql`).
3. `wrangler.jsonc`, `.gitignore`, `.env.example`.
4. Comprehensive `README.md` with instructions on setting up Google Cloud Console OAuth credentials, Cloudflare KV namespace, Cloudflare D1 database, and running `wrangler secret put`.
