// A sliding-window counter per key (an IP, usually): `hit(key)` records one
// event and says whether the key is now over the limit. Memory only — a
// restart forgets, which is fine for what this guards.

export type Limiter = (key: string) => boolean;

export function createLimiter(max: number, windowMs: number): Limiter {
  const recent = new Map<string, number[]>();
  return (key) => {
    const now = Date.now();
    if (recent.size > 5000) {
      for (const [k, hits] of recent) if (hits.every((t) => now - t >= windowMs)) recent.delete(k);
    }
    const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    recent.set(key, hits);
    return hits.length > max;
  };
}
