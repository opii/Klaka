// Mere i akumulatori senzora (core/spec/events.md §2), bez browsera.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Compose } from "../src/compose.js";
import { Engage, SEEN_MAX } from "../src/engage.js";
import { decile, depth, keysBucket, lengthBucket, pastedBucket, referrer, viewport } from "../src/measure.js";
import { Sender } from "../src/send.js";

test("referer: samo origin + putanja", () => {
  assert.equal(referrer("https://t.co/abc?x=1#y"), "https://t.co/abc");
  assert.equal(referrer("https://example.com"), "https://example.com/");
  assert.equal(referrer(""), null);
  assert.equal(referrer("nije url"), null);
});

test("viewport na 100 px, dubina u promilima", () => {
  assert.deepEqual(viewport(1366, 649), [1400, 600]);
  assert.equal(depth(500, 1000), 500);
  assert.equal(depth(2000, 1000), 1000);
  assert.equal(depth(10, 0), 0);
  assert.deepEqual([decile(0), decile(99), decile(100), decile(1000)], [0, 0, 1, 9]);
});

test("opsezi za compose", () => {
  assert.deepEqual([0, 1, 10, 11, 50, 51, 200, 201].map(keysBucket), ["0", "1-10", "1-10", "11-50", "11-50", "51-200", "51-200", "200+"]);
  assert.deepEqual([0, 50, 51, 200, 201].map(pastedBucket), ["0", "1-50", "51-200", "51-200", "200+"]);
  assert.deepEqual([0, 50, 51, 200, 201, 1000, 1001].map(lengthBucket), ["0", "1-50", "51-200", "51-200", "201-1000", "201-1000", "1000+"]);
});

test("engage: vidljivo vreme, histogram, dubina, skokovi, unos, seen", () => {
  const e = new Engage(1_000);
  e.scroll(1_000, 300);
  e.tick(1_250, true, 150); // 250 ms u desetini 1
  e.tick(1_500, false, 150); // tab skriven: ne računa se
  e.tick(2_000, true, 950); // 500 ms u desetini 9
  e.scroll(2_010, 950); // skok sa 300 na 950 posle 1 s — nije skok (sporo)
  e.scroll(2_050, 300); // 650 promila za 40 ms — skok
  e.input("ptr", 1_400);
  e.input("key", 1_800);
  e.commentsVisible(1_900);
  e.commentsVisible(2_500);
  e.seenComment("c1");
  e.seenComment("c1");
  e.seenComment("c2");

  const s = e.snapshot(3_000);
  assert.equal(s.dwell_ms, 2_000);
  assert.equal(s.visible_ms, 750);
  assert.equal(s.depth_hist[1], 250);
  assert.equal(s.depth_hist[9], 500);
  assert.equal(s.depth_max, 950);
  assert.equal(s.jumps, 1);
  assert.equal(s.first_input_ms, 400);
  assert.deepEqual(s.inputs, { key: 1, ptr: 1, touch: 0 });
  assert.equal(s.comments_ms, 900);
  assert.deepEqual(s.seen, ["c1", "c2"]);
  assert.equal(s.seq, 0);
  assert.equal(e.snapshot(3_100).seq, 1);
});

test("engage i compose: samo celi ms, i kad sat daje delove (performance.now)", () => {
  const e = new Engage(10.4);
  e.tick(260.9, true, 0);
  e.input("key", 300.7);
  e.commentsVisible(400.2);
  const s = e.snapshot(1_000.6);
  const ints = [s.dwell_ms, s.visible_ms, s.first_input_ms, s.comments_ms, ...s.depth_hist];
  assert.ok(ints.every((x) => Number.isInteger(x)), JSON.stringify(s));

  const c = new Compose();
  c.focus(1.3);
  assert.ok(Number.isInteger(c.submit(900.9, 10).focus_ms));
});

test("engage: najviše 200 komentara u seen", () => {
  const e = new Engage(0);
  for (let i = 0; i < 250; i++) e.seenComment(`c${i}`);
  assert.equal(e.snapshot(1).seen.length, SEEN_MAX);
});

test("compose: nalepljen tekst bez kucanja (potpis operatera), pa reset", () => {
  const c = new Compose();
  c.focus(1_000);
  c.paste(300);
  assert.deepEqual(c.submit(1_900, 300), { focus_ms: 900, keys: "0", pasted: true, pasted_chars: "200+", length: "201-1000" });
  assert.deepEqual(c.submit(2_000, 0), { focus_ms: 0, keys: "0", pasted: false, pasted_chars: "0", length: "0" });
});

test("sender: koverta v1, najviše 100 događaja", () => {
  const sent: { url: string; body: { v: number; portal: string; events: unknown[] } }[] = [];
  const s = new Sender("https://c.example/v1/events", "demo.local", (url, body) => {
    sent.push({ url, body: JSON.parse(body) });
    return true;
  });
  s.flush(); // prazan red: ništa
  for (let i = 0; i < 150; i++) s.push({ type: "honeypot", vid: "v", t: i, hp: "h", kind: "click" });
  s.flush();
  assert.deepEqual(sent.map((x) => x.body.events.length), [100, 50]);
  assert.equal(sent[0]!.url, "https://c.example/v1/events");
  assert.equal(sent[0]!.body.v, 1);
  assert.equal(sent[0]!.body.portal, "demo.local");
});
