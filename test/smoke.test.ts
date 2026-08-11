import { env } from "cloudflare:workers";
import { it } from "vitest";

it("migrations applied: can insert and read a user", async ({ expect }) => {
  await env.DB.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("u-smoke", "smoke@example.com").run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind("u-smoke").first<{ email: string }>();
  expect(row?.email).toBe("smoke@example.com");
});
