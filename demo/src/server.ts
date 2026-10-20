// Demo portal: jedan članak, komentari, glasanje. Bez framework-a, samo node:http.
//
// Okruženje:
//   PORT                 (3000)
//   KLAKA_PORTAL           (demo.local)
//   KLAKA_API_URL          klaka-api sa servera, za /v1/keys       (http://localhost:18081)
//   KLAKA_API_PUBLIC_URL   klaka-api iz browsera, za /v1/view      (= KLAKA_API_URL)
//   KLAKA_COLLECTOR_PUBLIC_URL  klaka-collector iz browsera, za /v1/events (bez njega: bez događaja)
//   KLAKA_SNIPPET          putanja do klaka.min.js                 (../ts/dist/klaka.min.js)
//   KLAKA_MIN_AGE_MS, KLAKA_MAX_AGE_MS, KLAKA_MAX_USES               (2000, 7200000, 50)
//   KLAKA_VALKEY_URL       brojač upotreba, ponovljeni glasovi, presude; bez njega se ne proveravaju
//   KLAKA_COLLECTOR_URL, KLAKA_API_KEY   slanje događaja; bez njih se događaji ne šalju
//   KLAKA_CLIENT_IP_HEADER   zaglavlje sa IP-jem klijenta iza pouzdanog proxy-ja (npr.
//                            x-forwarded-for, važi poslednja vrednost). SAMO za test okruženje:
//                            ovako emulator ćacija (caci/) dodeljuje adrese.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { EventSender, Klaka, type Policy } from "@klaka/sdk-node";

import { adminPage, articlePage, type Comment, type VoteLog } from "./page.js";
import { valkeyStore } from "./valkey.js";

const env = process.env;
const PORT = Number(env.PORT ?? 3000);
const PORTAL = env.KLAKA_PORTAL ?? "demo.local";
const POST = "p-1001";
const API = (env.KLAKA_API_URL ?? "http://localhost:18081").replace(/\/+$/, "");
const API_PUBLIC = env.KLAKA_API_PUBLIC_URL ?? API;
const COLLECTOR_PUBLIC = env.KLAKA_COLLECTOR_PUBLIC_URL ?? "";
const POLICY: Policy = {
  minAgeMs: Number(env.KLAKA_MIN_AGE_MS ?? 2_000),
  maxAgeMs: Number(env.KLAKA_MAX_AGE_MS ?? 7_200_000),
  maxUses: Number(env.KLAKA_MAX_USES ?? 50),
};
const MAX_BODY = 4 * 1024;
const IP_HEADER = env.KLAKA_CLIENT_IP_HEADER?.toLowerCase() || null;

const events =
  env.KLAKA_COLLECTOR_URL && env.KLAKA_API_KEY
    ? new EventSender({ portal: PORTAL, collectorUrl: env.KLAKA_COLLECTOR_URL, apiKey: env.KLAKA_API_KEY })
    : null;
const store = env.KLAKA_VALKEY_URL ? await valkeyStore(env.KLAKA_VALKEY_URL) : null;

const snippet = readSnippet(env.KLAKA_SNIPPET ?? "../ts/dist/klaka.min.js");

const comments: Comment[] = [
  { id: "c1", author: "Milica", text: "Konačno! Staza je bila u očajnom stanju.", score: 0 },
  { id: "c2", author: "Dragan", text: "Klupe su lepe, ali ko će održavati rasvetu?", score: 0 },
  { id: "c3", author: "Jelena", text: "Ograđen prostor za pse bi rešio dosta sukoba.", score: 0 },
  { id: "c4", author: "Stefan", text: "Nadam se da radovi neće trajati do leta.", score: 0 },
];
const votes: VoteLog[] = [];

// Ključevi se učitavaju sa klaka-api (spec token.md §6: MOŽE za razvoj; produkcija ih pinuje)
// i osvežavaju, jer klaka-api bez KLAKA_SIGNING_SEED pravi nov ključ pri svakom startu.
let klaka: Klaka | null = null;
let keysJson = "";

async function refreshKeys(): Promise<void> {
  try {
    const res = await fetch(`${API}/v1/keys`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { keys: Record<string, string> };
    const json = JSON.stringify(body.keys);
    if (json !== keysJson) {
      if (klaka) klaka.setKeys(body.keys);
      else klaka = new Klaka({ portal: PORTAL, keys: body.keys, policy: POLICY, ...(store && { store }), ...(events && { events }) });
      keysJson = json;
      console.log(`ključevi učitani: ${Object.keys(body.keys).join(", ")}`);
    }
  } catch (e) {
    console.warn(`klaka-api ključevi nedostupni (${API}): ${(e as Error).message}`);
  }
}

async function vote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const comment = comments.find((c) => c.id === body?.comment);
  const dir = body?.dir;
  if (!comment || (dir !== 1 && dir !== -1)) return send(res, 400, "application/json", '{"ok":false}');

  const header = req.headers["x-klaka-token"];
  const token = Array.isArray(header) ? header[0] : header;
  const now = Date.now();

  // Bez ključeva (klaka-api nedostupan pri startu) nijedan token ne može da se proveri.
  const r = klaka
    ? await klaka.onVote(
        { token, ip: clientIp(req), ua: req.headers["user-agent"] },
        { post: POST, target: comment.id, targetAuthor: comment.author, dir },
      )
    : { decision: "shadow" as const, vid: null, token: "unknown_key" as const, uses: null, repeat: null };
  if (r.decision === "count") comment.score += dir;
  votes.push({ t: now, comment: comment.id, dir, vid: r.vid, token: r.token, uses: r.uses, repeat: r.repeat, decision: r.decision });

  // Isti odgovor za count i shadow (spec README, princip 3).
  send(res, 200, "application/json", '{"ok":true}');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://demo");
  const route = `${req.method} ${url.pathname}`;
  Promise.resolve()
    .then(() => {
      switch (route) {
        case "GET /":
          return send(res, 200, "text/html; charset=utf-8",
            articlePage({ apiPublic: API_PUBLIC, collectorPublic: COLLECTOR_PUBLIC, portal: PORTAL, post: POST, comments }));
        case "GET /klaka.min.js":
          return send(res, 200, "text/javascript; charset=utf-8", snippet);
        case "POST /api/vote":
          return vote(req, res);
        case "GET /api/comments":
          return send(res, 200, "application/json", JSON.stringify(comments));
        case "GET /admin":
          return send(res, 200, "text/html; charset=utf-8", adminPage(votes, comments));
        case "GET /admin/votes.json":
          return send(res, 200, "application/json", JSON.stringify(votes));
        case "GET /healthz":
          return send(res, 200, "text/plain", "ok");
        default:
          return send(res, 404, "text/plain", "nema");
      }
    })
    .catch((e: Error) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, "text/plain", "greška");
    });
});

/** IP klijenta: iz zaglavlja pouzdanog proxy-ja (poslednja vrednost) ako je podešeno, inače TCP veza. */
function clientIp(req: IncomingMessage): string {
  const raw = IP_HEADER ? req.headers[IP_HEADER] : undefined;
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  const last = value?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "";
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readSnippet(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.warn(`snippet nije pronađen (${path}) — pokreni build u ts/`);
    return "/* klaka.min.js nije izgrađen */";
  }
}

await refreshKeys();
setInterval(refreshKeys, 15_000).unref();
events?.send({
  type: "post", t: Date.now(), post: POST, rev: 1, url: `https://${PORTAL}/`,
  title: "Park kod reke dobija novu stazu i klupe do proleća", section: "grad",
});
server.listen(PORT, () =>
  console.log(`demo portal na :${PORT} (klaka-api: ${API}, browser: ${API_PUBLIC}, događaji: ${events ? "da" : "ne"})`),
);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => void (events?.flush() ?? Promise.resolve()).finally(() => process.exit(0)));
    server.closeAllConnections();
  });
}
