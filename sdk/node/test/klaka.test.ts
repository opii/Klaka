// Tok glasa i komentara (core/spec/sdk.md §2, §2a): token, brojač upotreba, ponovljen glas,
// presude, otkazi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Klaka, MemoryStore, type EventSender, type ServerEvent, type Store } from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../core/spec/test-vectors/token.json", import.meta.url)), "utf8"),
) as {
  config: { portal: string; keys: Record<string, string>; min_age_ms: number; max_age_ms: number; max_uses: number };
  defaults: { post: string; now_ms: number };
  cases: { input: { token: string | null; post?: string; now_ms?: number }; expect: string }[];
};
const VALID = vectors.cases.find((c) => c.expect === "valid" && Object.keys(c.input).length === 1)!.input.token!;
const NOW = vectors.defaults.now_ms;
const POST = vectors.defaults.post;
const IP = "93.87.12.200";
// payload je drugi deo tokena (token.md §2)
const VID = (JSON.parse(Buffer.from(VALID.split(".")[2]!, "base64url").toString()) as { vid: string }).vid;

function setup(store?: Store, budgetMs?: number): { klaka: Klaka; sent: ServerEvent[] } {
  const sent: ServerEvent[] = [];
  const events = { send: (e: ServerEvent) => void sent.push(e) } as unknown as EventSender;
  const klaka = new Klaka({
    portal: vectors.config.portal,
    keys: vectors.config.keys,
    policy: { minAgeMs: vectors.config.min_age_ms, maxAgeMs: vectors.config.max_age_ms, maxUses: vectors.config.max_uses },
    events,
    now: () => NOW,
    ...(store ? { store } : {}),
    ...(budgetMs !== undefined ? { budgetMs } : {}),
  });
  return { klaka, sent };
}

const req = (token: string | null = VALID) => ({ token, ip: IP, ua: "UA" });
const vote = (target: string, dir: 1 | -1 = 1) => ({ post: POST, target, targetAuthor: "autor", dir });

test("prvi glas prikaza na cilj se računa; ponovljen ide u shadow", async () => {
  const { klaka, sent } = setup(new MemoryStore(() => NOW));
  const first = await klaka.onVote(req(), vote("c1"));
  assert.deepEqual(first, { decision: "count", vid: VID, token: "valid", uses: 1, repeat: false, action: "none" });

  const again = await klaka.onVote(req(), vote("c1", -1));
  assert.deepEqual(again, { decision: "shadow", vid: VID, token: "valid", uses: 2, repeat: true, action: "none" });

  const other = await klaka.onVote(req(), vote("c2"));
  assert.equal(other.decision, "count");

  assert.equal(sent.length, 3);
  assert.deepEqual(
    sent.map((e) => e.type === "vote" && [e.target, e.repeat, e.decision, e.net]),
    [["c1", false, "count", "93.87.12.0/24"], ["c1", true, "shadow", "93.87.12.0/24"], ["c2", false, "count", "93.87.12.0/24"]],
  );
});

test("posle max_uses: overused", async () => {
  const store = new MemoryStore(() => NOW);
  const { klaka } = setup(store);
  for (let i = 0; i < vectors.config.max_uses; i++) await klaka.onVote(req(), vote(`c${i}`));
  const over = await klaka.onVote(req(), vote("poslednji"));
  assert.deepEqual([over.token, over.decision, over.uses], ["overused", "shadow", vectors.config.max_uses + 1]);
});

test("presuda za mrežni prefiks važi i bez tokena", async () => {
  const store = new MemoryStore(() => NOW);
  store.set("klaka:v1:demo.local:net:93.87.12.0/24", JSON.stringify({ action: "shadow", until_ms: NOW + 1 }), 60_000);
  const { klaka } = setup(store);
  const withToken = await klaka.onVote(req(), vote("c1"));
  assert.deepEqual([withToken.decision, withToken.action], ["shadow", "shadow"]);
  const noToken = await klaka.onVote(req(null), vote("c1"));
  assert.deepEqual(noToken, { decision: "shadow", vid: null, token: "missing", uses: null, repeat: null, action: "shadow" });
});

test("Valkey pao ili spor: fail-open za presude, token i dalje odlučuje", async () => {
  const broken: Store = {
    incr: () => Promise.reject(new Error("ECONNREFUSED")),
    setNx: () => Promise.reject(new Error("ECONNREFUSED")),
    mget: () => Promise.reject(new Error("ECONNREFUSED")),
  };
  const never = new Promise<never>(() => {});
  const slow: Store = { incr: () => never, setNx: () => never, mget: () => never };

  for (const store of [broken, slow, undefined]) {
    const { klaka, sent } = setup(store, 5);
    assert.deepEqual(await klaka.onVote(req(), vote("c1")), {
      decision: "count", vid: VID, token: "valid", uses: null, repeat: null, action: "none",
    });
    assert.equal((await klaka.onVote(req("lažan"), vote("c1"))).decision, "shadow");
    assert.equal(sent.length, 2, "događaj ide i kad Valkey ne radi");
  }
});

test("pun IP ne ide u događaj; neispravan IP → bez događaja", async () => {
  const { klaka, sent } = setup(new MemoryStore(() => NOW));
  await klaka.onVote({ token: VALID, ip: "2a02:8109:1234:5678::1", ua: undefined }, vote("c1"));
  await klaka.onVote({ token: VALID, ip: "nije-ip", ua: undefined }, vote("c2"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.type === "vote" && sent[0]!.net, "2a02:8109:1234::/48");
  assert.ok(!JSON.stringify(sent).includes("5678"));
});

test("komentar: isti tok kao glas, bez pravila ponovljenog glasa; brojač upotreba je zajednički", async () => {
  const store = new MemoryStore(() => NOW);
  const { klaka, sent } = setup(store);
  const comment = (id: string) => ({ post: POST, comment: id, author: "Ana", text: "Tekst.", replyTo: null });
  await klaka.onVote(req(), vote("c1"));
  const first = await klaka.onComment(req(), comment("k1"));
  assert.deepEqual(first, { decision: "count", vid: VID, token: "valid", uses: 2, action: "none" });
  assert.equal((await klaka.onComment(req(), comment("k2"))).decision, "count", "drugi komentar istog prikaza");
  assert.deepEqual(sent.at(-1), {
    type: "comment", t: NOW, post: POST, vid: VID, token: "valid", uses: 3, decision: "count",
    net: "93.87.12.0/24", ua: "UA", comment: "k2", author: "Ana", text: "Tekst.", reply_to: null,
  });

  store.set("klaka:v1:demo.local:net:93.87.12.0/24", JSON.stringify({ action: "shadow", until_ms: NOW + 1 }), 60_000);
  assert.equal((await klaka.onComment(req(), comment("k3"))).decision, "shadow", "presuda važi i za komentare");
  assert.equal((await klaka.onComment(req(null), comment("k4"))).token, "missing");
});
