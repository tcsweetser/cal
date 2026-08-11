declare namespace Cloudflare {
  interface Env {
    // Defined in vitest.config.ts, only present in the test runtime.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
