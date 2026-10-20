// Slanje događaja collector-u (core/spec/events.md §1, §3; core/spec/sdk.md §2, korak 5).

import { test } from "node:test";
import assert from "node:assert/strict";

import { EventSender, truncateUa, type VoteEvent } from "../src/index.js";

interface Call {
  url: string;
  auth: string;
  body: { v: number; portal: string; events: { type: string; target?: string }[] };
}

/** Lažni collector: odgovara redom zadatim statusima (ili baca grešku), beleži pozive. */
function fakeFetch(statuses: (number | "down")[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const status = statuses.shift() ?? 204;
    const headers = init!.headers as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization!, body: JSON.parse(init!.body as string) });
    if (status === "down") throw new TypeError("fetch failed");
    return new Response(null, { status });
  };
  return { fetch: f as typeof fetch, calls };
}

function vote(target: string): VoteEvent {
  return {
    type: "vote", t: 1, post: "p-1", vid: null, token: "missing", uses: null, decision: "shadow",
    net: "93.87.12.0/24", ua: "UA", target, target_author: null, dir: 1, repeat: null,
  };
}

function sender(f: typeof fetch, extra: { maxBuffer?: number; now?: () => number } = {}): EventSender {
  return new EventSender({
    portal: "demo.local", collectorUrl: "http://collector:8080/", apiKey: "k", fetch: f, flushMs: 60_000, ...extra,
  });
}

test("koverta ide na /v1/ingest sa API ključem", async () => {
  const { fetch, calls } = fakeFetch([204]);
  const s = sender(fetch);
  s.send(vote("c1"));
  s.send(vote("c2"));
  await s.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://collector:8080/v1/ingest");
  assert.equal(calls[0]!.auth, "Bearer k");
  assert.equal(calls[0]!.body.v, 1);
  assert.equal(calls[0]!.body.portal, "demo.local");
  assert.deepEqual(calls[0]!.body.events.map((e) => e.target), ["c1", "c2"]);
  assert.deepEqual(s.stats, { sent: 2, dropped: 0 });
});

test("najviše 100 događaja po koverti", async () => {
  const { fetch, calls } = fakeFetch([]);
  const s = sender(fetch);
  for (let i = 0; i < 250; i++) s.send(vote(`c${i}`));
  await s.flush();
  assert.deepEqual(calls.map((c) => c.body.events.length), [100, 100, 50]);
  assert.equal(s.stats.sent, 250);
});

test("koverta ostaje ispod 64 KB", async () => {
  const { fetch, calls } = fakeFetch([]);
  const s = sender(fetch);
  const text = "x".repeat(8 * 1024);
  for (let i = 0; i < 20; i++) {
    s.send({ ...vote("c"), type: "comment", comment: `k${i}`, author: "a", text, reply_to: null } as never);
  }
  await s.flush();
  assert.ok(calls.length > 1);
  for (const c of calls) assert.ok(Buffer.byteLength(JSON.stringify(c.body)) <= 64 * 1024);
  assert.equal(s.stats.sent, 20);
});

test("collector nedostupan: ponovni pokušaj, pa odbacivanje posle maxAge", async () => {
  let now = 0;
  const { fetch, calls } = fakeFetch(["down", 503]);
  const s = sender(fetch, { now: () => now });
  s.send(vote("c1"));
  await s.flush(); // mreža pala → nazad u red
  await s.flush(); // 503 → nazad u red
  assert.equal(s.stats.sent, 0);
  await s.flush(); // 204
  assert.equal(s.stats.sent, 1);
  assert.equal(calls.length, 3);

  const down = fakeFetch(["down"]);
  const s2 = sender(down.fetch, { now: () => now });
  s2.send(vote("c1"));
  now = 31_000;
  await s2.flush();
  assert.deepEqual(s2.stats, { sent: 0, dropped: 1 });
});

test("4xx se ne ponavlja", async () => {
  const { fetch, calls } = fakeFetch([401]);
  const s = sender(fetch);
  s.send(vote("c1"));
  await s.flush();
  await s.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(s.stats, { sent: 0, dropped: 1 });
});

test("pun bafer: novi događaji se odbacuju, send ne baca", () => {
  const { fetch } = fakeFetch([]);
  const s = sender(fetch, { maxBuffer: 2 });
  for (let i = 0; i < 5; i++) s.send(vote(`c${i}`));
  assert.equal(s.stats.dropped, 3);
});

test("send se vraća pre mreže", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async () => {
    await gate;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const s = sender(slow);
  s.send(vote("c1")); // sinhrono, bez čekanja
  const flushing = s.flush();
  assert.equal(s.stats.sent, 0);
  release();
  await flushing;
  assert.equal(s.stats.sent, 1);
});

test("user-agent: 512 bajtova, bez sečenja znaka", () => {
  assert.equal(truncateUa(undefined), "");
  assert.equal(truncateUa("Mozilla/5.0"), "Mozilla/5.0");
  const long = "š".repeat(300); // 600 bajtova
  const cut = truncateUa(long);
  assert.ok(Buffer.byteLength(cut) <= 512);
  assert.equal(cut, "š".repeat(256));
});
