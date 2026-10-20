// Presude i odluka (core/spec/verdicts.md, core/spec/sdk.md §2).

import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, parseVerdict, strongest } from "../src/index.js";

const NOW = 1_792_000_000_000;

test("važeća presuda", () => {
  assert.equal(parseVerdict(JSON.stringify({ action: "shadow", until_ms: NOW + 1 }), NOW), "shadow");
});

test("sve neispravno ili isteklo je none", () => {
  const cases = [
    null,
    "",
    "nije json",
    "[]",
    JSON.stringify({ action: "shadow" }),
    JSON.stringify({ action: "shadow", until_ms: NOW - 1 }),
    JSON.stringify({ action: "ban", until_ms: NOW + 1 }),
    JSON.stringify({ action: "toString", until_ms: NOW + 1 }),
  ];
  for (const raw of cases) assert.equal(parseVerdict(raw, NOW), "none", String(raw));
});

test("najstroža akcija", () => {
  assert.equal(strongest([]), "none");
  assert.equal(strongest(["none", "shadow", "none"]), "shadow");
  assert.equal(strongest(["shadow", "challenge"]), "challenge");
});

test("count samo za važeći token bez presude", () => {
  assert.equal(decide("valid", "none"), "count");
  assert.equal(decide("valid", "shadow"), "shadow");
  assert.equal(decide("valid", "challenge"), "shadow");
  assert.equal(decide("missing", "none"), "shadow");
  assert.equal(decide("expired", "none"), "shadow");
});
