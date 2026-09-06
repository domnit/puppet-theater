// What a chat turn cost. The API reports tokens, not money, so the rate table
// lives here and `recordSpend` stores the dollars it produces — the ledger and
// the daily ceiling of spec §4.5 are both read from that one number.
//
// Rates are $/MTok and are matched by prefix, so a dated model id
// (`claude-sonnet-5-20260514`) uses its family's row. An id that matches
// nothing is billed at the opus rate: guessing high means an unknown model
// trips the ceiling early rather than spending past it.

export interface Usage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface Rate {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const RATES: Record<string, Rate> = {
  "claude-sonnet-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  "claude-fable-5-1": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
};

/** The row an unknown model is billed at. */
const FALLBACK = "claude-opus-5";

const PER_TOKEN = 1e-6;

/** The rate row for a model id: the longest prefix that matches, else opus. */
export function rateFor(model: string): Rate {
  let best: string | null = null;
  for (const key of Object.keys(RATES)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return RATES[best ?? FALLBACK];
}

export function costUsd(model: string, usage: Usage): number {
  const rate = rateFor(model);
  return (
    PER_TOKEN *
    (usage.inputTokens * rate.input +
      usage.cacheWriteTokens * rate.cacheWrite +
      usage.cacheReadTokens * rate.cacheRead +
      usage.outputTokens * rate.output)
  );
}

/** Midnight UTC of the current day, in ms — the window the daily ceiling sums over. */
export function startOfDayUtc(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The four counters this project bills on, from an API message's `usage`. */
export function usageOf(msg: {
  usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens: number;
  };
}): Usage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
  };
}
