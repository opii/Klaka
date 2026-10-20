// Zajednički test vektori iz core/spec/test-vectors/token.json (spec token.md §4).
// Dok smo monorepo, čitaju se relativnom putanjom; PPD_TEST_VECTORS je može zameniti.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TokenVerifier, type TokenResult } from "../src/index.js";

interface Vectors {
  config: {
    portal: string;
    keys: Record<string, string>;
    min_age_ms: number;
    max_age_ms: number;
    max_uses: number;
  };
  defaults: { portal: string; post: string; now_ms: number; uses: number };
  cases: {
    name: string;
    input: { token: string | null; post?: string; now_ms?: number; uses?: number };
    expect: TokenResult;
  }[];
}

// dist/test/ → sdk/node/ → koren repoa
const path =
  process.env.PPD_TEST_VECTORS ??
  fileURLToPath(new URL("../../../../core/spec/test-vectors/token.json", import.meta.url));
const doc = JSON.parse(readFileSync(path, "utf8")) as Vectors;

const verifier = new TokenVerifier(doc.config.portal, doc.config.keys, {
  minAgeMs: doc.config.min_age_ms,
  maxAgeMs: doc.config.max_age_ms,
  maxUses: doc.config.max_uses,
});

for (const c of doc.cases) {
  test(c.name, () => {
    const { post, now_ms, uses } = { ...doc.defaults, ...c.input };
    const got = verifier.checkUses(verifier.verify(c.input.token, post, now_ms), uses);
    assert.equal(got.result, c.expect);
  });
}

test("payload je dostupan i kad kasniji korak ne prođe", () => {
  const expired = doc.cases.find((c) => c.name === "expired")!;
  const v = verifier.verify(expired.input.token, doc.defaults.post, doc.defaults.now_ms);
  assert.equal(v.result, "expired");
  assert.equal(v.payload?.vid.length, 22);
});

test("neispravan javni ključ se odbija pri konstrukciji", () => {
  const p = { minAgeMs: 0, maxAgeMs: 1, maxUses: 1 };
  assert.throws(() => new TokenVerifier("x", { k: "nije-kljuc" }, p));
  assert.throws(() => new TokenVerifier("x", {}, p));
});
