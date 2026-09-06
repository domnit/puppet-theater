// The chat's rate table: what a turn cost, and the day the ceiling sums over.

import { describe, expect, test } from "bun:test";
import { costUsd, RATES, startOfDayUtc, usageOf } from "../src/server/spend";

const usage = { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

describe("costUsd", () => {
  test("bills each counter at its own rate", () => {
    const cost = costUsd("claude-sonnet-5", {
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2 + 2.5 + 0.2 + 10, 10);
    expect(costUsd("claude-haiku-4-5", usage)).toBeCloseTo(1, 10);
    expect(costUsd("claude-sonnet-5", { ...usage, inputTokens: 0 })).toBe(0);
  });

  test("a dated variant matches its family by prefix", () => {
    expect(costUsd("claude-sonnet-5-20260514", usage)).toBeCloseTo(RATES["claude-sonnet-5"].input, 10);
    expect(costUsd("claude-fable-5-1-preview", usage)).toBeCloseTo(RATES["claude-fable-5-1"].input, 10);
  });

  test("an unknown model is billed at the opus rate, which is the conservative one", () => {
    expect(costUsd("claude-something-new", usage)).toBeCloseTo(RATES["claude-opus-5"].input, 10);
    expect(costUsd("", usage)).toBeCloseTo(RATES["claude-opus-5"].input, 10);
    for (const rate of Object.values(RATES)) expect(rate.input).toBeLessThanOrEqual(RATES["claude-opus-5"].input * 2);
  });
});

test("startOfDayUtc is midnight UTC of the day it is given", () => {
  const noon = Date.UTC(2026, 0, 15, 12, 30, 45, 123);
  expect(startOfDayUtc(noon)).toBe(Date.UTC(2026, 0, 15));
  expect(startOfDayUtc(Date.UTC(2026, 0, 15))).toBe(Date.UTC(2026, 0, 15));
  expect(startOfDayUtc(Date.UTC(2026, 0, 16) - 1)).toBe(Date.UTC(2026, 0, 15));
  expect(startOfDayUtc()).toBeLessThanOrEqual(Date.now());
});

test("usageOf reads the four counters, with the cache fields absent or null", () => {
  expect(usageOf({ usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 9 } })).toEqual({
    inputTokens: 7,
    cacheWriteTokens: 5,
    cacheReadTokens: 9,
    outputTokens: 3,
  });
  expect(usageOf({ usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: null } })).toEqual({
    inputTokens: 7,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 3,
  });
  expect(usageOf({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({
    inputTokens: 7,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 3,
  });
});
