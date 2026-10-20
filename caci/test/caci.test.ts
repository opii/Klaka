// Spajanje dnevnika sa događajima iz baze, adrese i profil.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Prefixes } from "../src/net.js";
import { parseProfile } from "../src/profile.js";
import { match, summarize, type StoredVote } from "../src/report.js";
import type { Action, RunLog } from "../src/run.js";

function action(over: Partial<Action>): Action {
  return {
    t: 1_000, role: "amplifier", side: "A", level: 0, actor: "A-amplifier-0", net: "198.18.1.0/24",
    vid: null, post: "p-1001", target: "c1", dir: 1, status: 200, ...over,
  };
}

function stored(over: Partial<StoredVote>): StoredVote {
  return { t: 1_005, vid: null, net: "198.18.1.0/24", target: "c1", dir: 1, token: "missing", decision: "shadow", repeat: null, ...over };
}

test("spajanje: cilj, smer, prefiks, vid i vremenski prozor", () => {
  const a = action({});
  const withVid = action({ t: 2_000, vid: "v1" });
  const votes = [
    stored({ t: 1_005 }),
    stored({ t: 1_010, target: "c2" }),
    stored({ t: 2_001, vid: "v2" }),
    stored({ t: 2_002, vid: "v1", token: "valid", decision: "count" }),
  ];
  const m = match([a, withVid], votes);
  assert.equal(m.get(a)?.t, 1_005);
  assert.equal(m.get(withVid)?.vid, "v1");
});

test("spajanje: događaj se koristi jednom; van prozora nema para", () => {
  const a1 = action({ t: 1_000 });
  const a2 = action({ t: 1_001 });
  const far = action({ t: 9_000 });
  const m = match([a1, a2, far], [stored({ t: 1_002 })]);
  assert.equal(m.size, 1);
  assert.ok(!m.has(far));
});

test("izveštaj: shadow i pomeraj po grupi", () => {
  const actions = [
    action({ t: 1 }), action({ t: 2 }),
    action({ t: 3, role: "reader", side: null, level: null, actor: "reader-0", net: "198.19.9.0/24", target: "c4" }),
  ];
  const votes = [
    stored({ t: 1 }),
    stored({ t: 2, token: "valid", decision: "count" }),
    stored({ t: 3, net: "198.19.9.0/24", target: "c4", token: "valid", decision: "count" }),
  ];
  const log = { run: "r", actions } as RunLog;
  const rows = summarize(log, votes);
  const amp = rows.find((r) => r.group.startsWith("A pojačivači"))!;
  assert.deepEqual([amp.votes, amp.matched, amp.shadow, amp.counted], [2, 2, 1, 1]);
  const readers = rows.find((r) => r.group === "čitaoci")!;
  assert.deepEqual([readers.shadow, readers.counted], [0, 1]);
});

test("adrese: svaki /24 jednom, u 198.18.0.0/15", () => {
  const p = new Prefixes();
  const seen = new Set<string>();
  for (let i = 0; i < 512; i++) {
    const x = p.take();
    assert.match(x, /^198\.(18|19)\.\d{1,3}$/);
    assert.ok(!seen.has(x));
    seen.add(x);
  }
  assert.throws(() => p.take());
  assert.match(p.host("198.18.7"), /^198\.18\.7\.(\d{1,3})$/);
});

test("profili iz repoa su ispravni", () => {
  for (const f of ["rafal-0", "token-1", "svez-token-1", "browser-2", "browser-2-klik", "pazljiv-3"]) {
    const p = parseProfile(JSON.parse(readFileSync(new URL(`../../profiles/${f}.json`, import.meta.url), "utf8")));
    assert.equal(p.name, f);
  }
  assert.throws(() => parseProfile({ name: "x", level: 7 }), /level/);
});
