// Spajanje dnevnika sa događajima iz baze, adrese, profil, plan poslušnika i tekstovi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { Prefixes } from "../src/net.js";
import { parseProfile, schedule } from "../src/profile.js";
import { match, summarize, summarizeComments, threads, type StoredComment, type StoredVote } from "../src/report.js";
import { operativePlan, type Action, type CommentAction, type RunLog } from "../src/run.js";
import { clean, lines, templated, TEMPLATES } from "../src/texts.js";

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

  // Naknadni shadow uračunatog glasa: pomeraj pada, shadow u trenutku glasa ostaje isti.
  const retro = { comments: new Set<string>(), votes: new Set(["null c1"]) };
  const after = summarize(log, votes, retro).find((r) => r.group.startsWith("A pojačivači"))!;
  assert.deepEqual([after.shadow, after.retro, after.counted], [1, 1, 0]);
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
  const dir = new URL("../../profiles/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 9, files.join(", "));
  for (const f of files) {
    const p = parseProfile(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    assert.equal(p.name, f.replace(/\.json$/, ""));
  }
  assert.throws(() => parseProfile({ name: "x", level: 7 }), /level/);
});

test("raspored: komentari ravnomerno među glasovima", () => {
  assert.deepEqual(schedule(4, 2), ["vote", "vote", "comment", "vote", "vote", "comment"]);
  assert.deepEqual(schedule(0, 2), ["comment", "comment"]);
  assert.equal(schedule(10, 3).filter((k) => k === "comment").length, 3);
});

test("plan poslušnika: ciljevi u krug, komentari na članke ciljeva, rotacija pseudonima", () => {
  const p = parseProfile({
    name: "x", level: 4, roles: { amplifier: 1, diluter: 1 }, votes: 3, comments: 2, pseudonyms: 2,
    targets: { push: ["c1", "c6"], sink: [], dilute: ["p-1003"] }, mirror: false, window_s: 1, prefixes: 1,
    delay_ms: { median: 1, sigma: 0 }, token_wait_ms: 0,
    audience: { readers: 0, read_ms: { median: 1, sigma: 0 }, vote_p: 0 },
  });
  const goals = [{ id: "c1", post: "p-1001" }, { id: "c6", post: "p-1002" }];
  const amp = operativePlan(p, "amplifier", goals, ["t1", "t2"], 0);
  assert.deepEqual(amp.map((t) => (t.kind === "vote" ? t.goal!.id : t.post)), ["c1", "c6", "p-1001", "c1", "p-1002"]);
  const authors = amp.flatMap((t) => (t.kind === "comment" ? [t.author] : []));
  assert.equal(authors.length, 2);
  const dil = operativePlan(p, "diluter", [], ["t1", "t2"], 0);
  assert.ok(dil.every((t) => (t.kind === "vote" ? t.goal === null && t.dir === 1 : t.post === "p-1003")));
});

test("plan poslušnika: isti šablon kod različitih poslušnika ide na različite članke", () => {
  // Deljeni šabloni broje samo blizance sa drugog posta: da šablon i članak idu istim korakom,
  // poslušnici jedne strane se ne bi videli među sobom.
  const p = parseProfile({
    name: "x", level: 3, roles: { amplifier: 6 }, votes: 0, comments: 3,
    targets: { push: ["c1", "c6", "c11"], sink: [] }, mirror: false, window_s: 1, prefixes: 6,
    delay_ms: { median: 1, sigma: 0 }, token_wait_ms: 0,
    audience: { readers: 0, read_ms: { median: 1, sigma: 0 }, vote_p: 0 },
  });
  const goals = [{ id: "c1", post: "p-1001" }, { id: "c6", post: "p-1002" }, { id: "c11", post: "p-1003" }];
  const posts = new Map<string, Set<string>>();
  for (let i = 0; i < 6; i++) {
    for (const t of operativePlan(p, "amplifier", goals, templated(TEMPLATES.amplifier, 3, i), i)) {
      if (t.kind === "comment") posts.set(t.text, (posts.get(t.text) ?? new Set()).add(t.post));
    }
  }
  assert.equal(posts.size, 5);
  assert.ok([...posts.values()].every((s) => s.size >= 2), JSON.stringify([...posts].map(([k, s]) => [k, [...s]])));
});

test("komentari: spajanje po ID-ju, udeo klake u javnim komentarima članka", () => {
  const c = (over: Partial<CommentAction>): CommentAction => ({
    t: 1, role: "diluter", side: "A", level: 2, actor: "A-diluter-0", net: "198.18.1.0/24", vid: null,
    post: "p-1003", id: "c20", author: "Goran", text: "Lep dan.", status: 200, ...over,
  });
  const log = {
    run: "r",
    comments: [c({}), c({ id: "c21" }), c({ id: "c22" }), c({ role: "reader", side: null, level: null, id: "c23" })],
  } as RunLog;
  const stored: StoredComment[] = [
    { id: "c20", post: "p-1003", token: "valid", decision: "count" },
    { id: "c21", post: "p-1003", token: "valid", decision: "count" },
    { id: "c22", post: "p-1003", token: "valid", decision: "shadow" },
    { id: "c23", post: "p-1003", token: "valid", decision: "count" },
  ];
  const rows = summarizeComments(log, stored);
  const dil = rows.find((r) => r.group.startsWith("A razvodnjivači"))!;
  assert.deepEqual([dil.written, dil.matched, dil.shadow], [3, 3, 1]);
  assert.deepEqual(threads(log, stored), [{ post: "p-1003", public: 3, klaka: 2, shadowed: 1 }]);

  // Naknadni shadow: c20 je skinut posle presude — više nije javan.
  const retro = { comments: new Set(["c20"]), votes: new Set<string>() };
  const after = summarizeComments(log, stored, retro).find((r) => r.group.startsWith("A razvodnjivači"))!;
  assert.deepEqual([after.shadow, after.retro], [1, 1]);
  assert.deepEqual(threads(log, stored, retro), [{ post: "p-1003", public: 2, klaka: 1, shadowed: 2 }]);
});

test("parafraza: prvi red bez navodnika; prazan ili predugačak odgovor se odbacuje", () => {
  assert.equal(clean({ response: '„Divan dan, pozdrav svima."\nObjašnjenje: ...' }), "Divan dan, pozdrav svima.");
  assert.equal(clean({ response: "   " }), null);
  assert.equal(clean({ response: "x".repeat(301) }), null);
});

test("komentari publike: po jedan u redu, bez numeracije i navodnika, bez ponavljanja", () => {
  const r = { response: '1. Konačno, čekamo ovo godinama.\n- „Ko će to platiti?"\n\n2) Konačno, čekamo ovo godinama.\nok' };
  assert.deepEqual(lines(r), ["Konačno, čekamo ovo godinama.", "Ko će to platiti?"]);
});

test("komentari publike: uvod modela nije komentar", () => {
  const r = { response: "Evo šest komentara čitalaca ispod članka:\n\n1. Konačno, čekamo ovo godinama." };
  assert.deepEqual(lines(r), ["Konačno, čekamo ovo godinama."]);
});
