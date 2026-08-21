import type { UserRow } from "../db/schema";
import type { SidebarUser } from "../views/layout";

// Shared across every /dashboard/* route handler that renders Layout —
// re-fetched per request rather than carried in the session cookie/KV value,
// same as accounts already are, so a changed name/photo shows up without
// needing to invalidate live sessions.
export function toSidebarUser(user: UserRow): SidebarUser {
  return { email: user.email, name: user.name, picture_url: user.picture_url };
}
