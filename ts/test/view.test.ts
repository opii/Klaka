// requestToken sa podmetnutim fetch-om (bez browsera i bez mreže).

import { test } from "node:test";
import assert from "node:assert/strict";

import { requestToken } from "../src/view.js";

const opts = { api: "https://klaka.example.org/", portal: "demo.local", post: "p-1001" };

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("šalje jednostavan CORS zahtev i vraća token", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ token: "klaka1.x", vid: "v" }), { status: 200 });
  }) as unknown as typeof fetch;

  assert.equal(await requestToken(opts, f), "klaka1.x");
  assert.equal(seen?.url, "https://klaka.example.org/v1/view");
  assert.equal(seen?.init.method, "POST");
  assert.deepEqual(seen?.init.headers, { "Content-Type": "text/plain" });
  assert.equal(seen?.init.credentials, "omit");
  assert.deepEqual(JSON.parse(String(seen?.init.body)), { portal: "demo.local", post: "p-1001" });
});

test("svaki neuspeh daje null", async () => {
  assert.equal(await requestToken(opts, respond(403, {})), null);
  assert.equal(await requestToken(opts, respond(200, { nije: "token" })), null);
  assert.equal(await requestToken(opts, respond(200, null)), null);
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await requestToken(opts, offline), null);
});

test("odustaje posle tajmauta", async () => {
  const hang = ((_: string, init: RequestInit) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await requestToken({ ...opts, timeoutMs: 50 }, hang), null);
  assert.ok(Date.now() - started < 1000);
});
