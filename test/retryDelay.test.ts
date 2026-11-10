import { it, expect } from "vitest";
import { retryDelayMs } from "../src/lib/retry";

it("uses exponential backoff when there is no Retry-After header", () => {
  expect(retryDelayMs(null, 1)).toBe(500);
  expect(retryDelayMs(null, 2)).toBe(1000);
});

it("honours a short Retry-After", () => {
  expect(retryDelayMs("2", 1)).toBe(2000);
});

it("caps a long Retry-After so a retry can't hold a sync open", () => {
  expect(retryDelayMs("3600", 1)).toBe(5000);
});

it("falls back to backoff when Retry-After isn't a number of seconds", () => {
  expect(retryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT", 1)).toBe(500);
  expect(retryDelayMs("-5", 1)).toBe(500);
});
