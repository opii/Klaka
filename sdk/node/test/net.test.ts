// Zajednički test vektori iz core/spec/test-vectors/net.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { netPrefix } from "../src/index.js";

const path = fileURLToPath(new URL("../../../../core/spec/test-vectors/net.json", import.meta.url));
const doc = JSON.parse(readFileSync(path, "utf8")) as {
  cases: { name: string; input: string; expect: string | null }[];
};

for (const c of doc.cases) {
  test(`net: ${c.name}`, () => assert.equal(netPrefix(c.input), c.expect));
}
