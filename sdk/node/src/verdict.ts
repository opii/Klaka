// Presude i odluka count/shadow — core/spec/verdicts.md i core/spec/sdk.md §2.

import type { TokenResult } from "./token.js";

export type Action = "none" | "shadow" | "challenge";
export type Decision = "count" | "shadow";

const STRENGTH: Record<Action, number> = { none: 0, shadow: 1, challenge: 2 };

/**
 * Vrednost ključa presude iz Valkey-ja → akcija. Sve što nije ispravna, važeća presuda je
 * `none`: nedostaje, neparsabilna, nepoznata akcija (verdicts.md §2), ili je `until_ms` prošao.
 */
export function parseVerdict(raw: string | null | undefined, nowMs: number): Action {
  if (!raw) return "none";
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return "none";
  }
  if (typeof v !== "object" || v === null) return "none";
  const { action, until_ms: until } = v as { action?: unknown; until_ms?: unknown };
  // hasOwn, ne `in`: `"toString" in STRENGTH` je true zbog prototipa.
  if (typeof action !== "string" || !Object.hasOwn(STRENGTH, action)) return "none";
  if (typeof until !== "number" || nowMs > until) return "none";
  return action as Action;
}

/** Najstroža akcija od svih presuda koje važe za akciju (verdicts.md §1). */
export function strongest(actions: Iterable<Action>): Action {
  let best: Action = "none";
  for (const a of actions) if (STRENGTH[a] > STRENGTH[best]) best = a;
  return best;
}

/** sdk.md §2, korak 4. `challenge` se u v1 tretira kao `shadow` (verdicts.md §3). */
export function decide(token: TokenResult, action: Action): Decision {
  return token === "valid" && action === "none" ? "count" : "shadow";
}
