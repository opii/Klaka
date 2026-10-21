// Demo portal: nekoliko članaka, komentari, glasanje. Bez framework-a, samo node:http.
//
// Okruženje:
//   PORT                 (3000)
//   KLAKA_PORTAL           (demo.local)
//   KLAKA_API_URL          klaka-api sa servera, za /v1/keys       (http://localhost:18081)
//   KLAKA_API_PUBLIC_URL   klaka-api iz browsera, za /v1/view      (= KLAKA_API_URL)
//   KLAKA_COLLECTOR_PUBLIC_URL  klaka-collector iz browsera, za /v1/events (bez njega: bez događaja)
//   KLAKA_SNIPPET          putanja do klaka.min.js                 (../ts/dist/klaka.min.js)
//   KLAKA_MIN_AGE_MS, KLAKA_MAX_AGE_MS, KLAKA_MAX_USES               (2000, 7200000, 50)
//   KLAKA_VALKEY_URL       brojač upotreba, ponovljeni glasovi, presude, naknadni shadow; bez njega ništa od toga
//   KLAKA_COLLECTOR_URL, KLAKA_API_KEY   slanje događaja; bez njih se događaji ne šalju
//   KLAKA_CLIENT_IP_HEADER   zaglavlje sa IP-jem klijenta iza pouzdanog proxy-ja (npr.
//                            x-forwarded-for, važi poslednja vrednost). SAMO za test okruženje:
//                            ovako emulator ćacija (caci/) dodeljuje adrese.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { EventSender, Klaka, type Policy, type RetroAction } from "@klaka/sdk-node";

import { POSTS, SEED_COMMENTS } from "./content.js";
import { adminPage, articlePage, homePage, type Comment, type VoteLog } from "./page.js";
import { valkeyStore } from "./valkey.js";

const env = process.env;
const PORT = Number(env.PORT ?? 3000);
const PORTAL = env.KLAKA_PORTAL ?? "demo.local";
const API = (env.KLAKA_API_URL ?? "http://localhost:18081").replace(/\/+$/, "");
const API_PUBLIC = env.KLAKA_API_PUBLIC_URL ?? API;
const COLLECTOR_PUBLIC = env.KLAKA_COLLECTOR_PUBLIC_URL ?? "";
const POLICY: Policy = {
  minAgeMs: Number(env.KLAKA_MIN_AGE_MS ?? 2_000),
  maxAgeMs: Number(env.KLAKA_MAX_AGE_MS ?? 7_200_000),
  maxUses: Number(env.KLAKA_MAX_USES ?? 50),
};
const MAX_BODY = 16 * 1024;
const MAX_AUTHOR = 40;
const MAX_TEXT = 2_000;
// Kolačić posetioca: po njemu autor vidi svoje shadow komentare. Pravi portal ima nalog ili sesiju.
const SID = "demo_sid";
const IP_HEADER = env.KLAKA_CLIENT_IP_HEADER?.toLowerCase() || null;

const events =
  env.KLAKA_COLLECTOR_URL && env.KLAKA_API_KEY
    ? new EventSender({ portal: PORTAL, collectorUrl: env.KLAKA_COLLECTOR_URL, apiKey: env.KLAKA_API_KEY })
    : null;
const store = env.KLAKA_VALKEY_URL ? await valkeyStore(env.KLAKA_VALKEY_URL) : null;

const snippet = readSnippet(env.KLAKA_SNIPPET ?? "../ts/dist/klaka.min.js");

const started = Date.now();
const comments: Comment[] = SEED_COMMENTS.map((c) => ({
  ...c, score: 0, t: started, decision: "count", owner: null, token: null,
}));
let nextComment = comments.length + 1;
// Novi komentari nose oznaku pokretanja: demo ne čuva stanje, a ID komentara mora biti
// jedinstven i posle restarta (engine po njemu vezuje embeddings, docs/llm.md §5a).
const INSTANCE = started.toString(36);
const votes: VoteLog[] = [];

/** Javni komentari i `shadow` komentari ovog posetioca. */
const visible = (c: Comment, sid: string | null) => c.decision === "count" || (sid !== null && c.owner === sid);

/**
 * Zbirovi kako ih vidi posetilac: javni zbir plus njegovi shadow glasovi (sdk.md §2) — inače
 * posle osvežavanja vidi da mu glas nije uračunat. Ostali vide samo javni zbir.
 */
function asSeenBy(list: Comment[], sid: string | null): Comment[] {
  if (sid === null) return list;
  const own = new Map<string, number>();
  for (const v of votes) {
    if (v.owner === sid && v.decision === "shadow") own.set(v.comment, (own.get(v.comment) ?? 0) + v.dir);
  }
  return own.size === 0 ? list : list.map((c) => (own.has(c.id) ? { ...c, score: c.score + own.get(c.id)! } : c));
}

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
      else {
        klaka = new Klaka({ portal: PORTAL, keys: body.keys, policy: POLICY, ...(store && { store }), ...(events && { events }) });
        announcePosts(klaka);
      }
      keysJson = json;
      console.log(`ključevi učitani: ${Object.keys(body.keys).join(", ")}`);
    }
  } catch (e) {
    console.warn(`klaka-api ključevi nedostupni (${API}): ${(e as Error).message}`);
  }
}

async function vote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const headers: Record<string, string> = {};
  const sid = cookie(req, SID) ?? newSid(headers);
  // Komentar koji posetilac ne vidi (tuđ shadow) ne postoji za njega.
  const comment = comments.find((c) => c.id === body?.comment && visible(c, sid));
  const dir = body?.dir;
  if (!comment || (dir !== 1 && dir !== -1)) return send(res, 400, "application/json", '{"ok":false}');

  const now = Date.now();
  // Bez ključeva (klaka-api nedostupan pri startu) nijedan token ne može da se proveri.
  const r = klaka
    ? await klaka.onVote(clientRequest(req), { post: comment.post, target: comment.id, targetAuthor: comment.author, dir })
    : { decision: "shadow" as const, vid: null, token: "unknown_key" as const, uses: null, repeat: null };
  if (r.decision === "count") comment.score += dir;
  votes.push({
    t: now, owner: sid, post: comment.post, comment: comment.id, dir, vid: r.vid, token: r.token, uses: r.uses,
    repeat: r.repeat, decision: r.decision,
  });

  // Isti odgovor za count i shadow (spec README, princip 3).
  send(res, 200, "application/json", '{"ok":true}', headers);
}

async function comment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const post = POSTS.find((p) => p.id === body?.post);
  const author = typeof body?.author === "string" ? body.author.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!post || !author || author.length > MAX_AUTHOR || !text || text.length > MAX_TEXT) {
    return send(res, 400, "application/json", '{"ok":false}');
  }
  const headers: Record<string, string> = {};
  const sid = cookie(req, SID) ?? newSid(headers);
  const id = `c${nextComment++}-${INSTANCE}`;
  const r = klaka
    ? await klaka.onComment(clientRequest(req), { post: post.id, comment: id, author, text, replyTo: null })
    : { decision: "shadow" as const, token: "unknown_key" as const };
  comments.push({ id, post: post.id, author, text, score: 0, t: Date.now(), decision: r.decision, owner: sid, token: r.token });

  // Isti odgovor za count i shadow: autor svoj komentar vidi u oba slučaja.
  send(res, 200, "application/json", JSON.stringify({ ok: true, id }), headers);
}

// Naknadni shadow (sdk.md §2b): akcije koje je engine uz presudu poslao da se skinu. Kursor je
// u memoriji, kao i sve ostalo u demo-u; počinje od starta, jer starije akcije ovaj proces ne zna.
let retroCursor = `${started}-0`;
const RETRO_MS = 2_000;

async function applyRetro(): Promise<void> {
  if (!klaka) return;
  const { cursor, actions } = await klaka.retro(retroCursor);
  for (const a of actions) applyRetroAction(a);
  retroCursor = cursor;
}

/** Idempotentno: već skinuta ili nepoznata akcija se preskače. */
function applyRetroAction(a: RetroAction): void {
  if (a.kind === "comment") {
    const c = comments.find((x) => x.id === a.comment && x.decision === "count");
    if (c) Object.assign(c, { decision: "shadow", retro: true });
    return;
  }
  const v = votes.find((x) => x.vid === a.vid && x.comment === a.target && x.decision === "count");
  if (!v) return;
  Object.assign(v, { decision: "shadow", retro: true });
  const c = comments.find((x) => x.id === v.comment);
  if (c) c.score -= v.dir;
}

/**
 * Samo za demo: „portal je poslao push" za post — pravi portal javlja promociju kad je sam
 * napravi (naslovna, push, newsletter). Emulator (caci/) ovako pušta legitimnog blizanca.
 */
async function promote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const post = POSTS.find((p) => p.id === body?.post);
  const channel = body?.channel ?? "push";
  if (!post || !["push", "homepage", "newsletter", "social", "other"].includes(channel as string)) {
    return send(res, 400, "application/json", '{"ok":false}');
  }
  klaka?.onPromotion(post.id, channel as "push");
  send(res, 200, "application/json", '{"ok":true}');
}

function article(req: IncomingMessage, res: ServerResponse, id: string): void {
  const post = POSTS.find((p) => p.id === id);
  if (!post) return send(res, 404, "text/plain", "nema");
  const headers: Record<string, string> = {};
  const sid = cookie(req, SID) ?? newSid(headers);
  const list = asSeenBy(comments.filter((c) => c.post === post.id && visible(c, sid)), sid);
  send(res, 200, "text/html; charset=utf-8",
    articlePage({ apiPublic: API_PUBLIC, collectorPublic: COLLECTOR_PUBLIC, portal: PORTAL, post, comments: list }), headers);
}

function publicComments(req: IncomingMessage, post: string | null): object[] {
  const sid = cookie(req, SID);
  return asSeenBy(comments.filter((c) => (post === null || c.post === post) && visible(c, sid)), sid)
    .map(({ id, post, author, text, score }) => ({ id, post, author, text, score }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://demo");
  const route = `${req.method} ${url.pathname}`;
  Promise.resolve()
    .then(() => {
      if (req.method === "GET" && url.pathname.startsWith("/p/")) return article(req, res, url.pathname.slice(3));
      switch (route) {
        case "GET /":
          return send(res, 200, "text/html; charset=utf-8", homePage({
            portal: PORTAL,
            posts: POSTS.map((post) => ({ post, comments: comments.filter((c) => c.post === post.id && c.decision === "count").length })),
          }));
        case "GET /klaka.min.js":
          return send(res, 200, "text/javascript; charset=utf-8", snippet);
        case "POST /api/vote":
          return vote(req, res);
        case "POST /api/comment":
          return comment(req, res);
        case "GET /api/posts":
          return send(res, 200, "application/json", JSON.stringify(POSTS.map(({ id, title }) => ({ id, title }))));
        case "GET /api/comments":
          return send(res, 200, "application/json", JSON.stringify(publicComments(req, url.searchParams.get("post"))));
        case "GET /admin":
          return send(res, 200, "text/html; charset=utf-8", adminPage(votes, comments));
        case "GET /admin/votes.json":
          return send(res, 200, "application/json", JSON.stringify(votes));
        case "GET /admin/comments.json":
          return send(res, 200, "application/json", JSON.stringify(comments));
        case "POST /admin/promote":
          return promote(req, res);
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

function clientRequest(req: IncomingMessage) {
  const header = req.headers["x-klaka-token"];
  return { token: Array.isArray(header) ? header[0] : header, ip: clientIp(req), ua: req.headers["user-agent"] };
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === name && v && /^[\w-]{16,64}$/.test(v)) return v;
  }
  return null;
}

/** Nov kolačić posetioca; `Set-Cookie` ide u `headers` odgovora. */
function newSid(headers: Record<string, string>): string {
  const sid = randomBytes(16).toString("base64url");
  headers["Set-Cookie"] = `${SID}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  return sid;
}

/** IP klijenta: iz zaglavlja pouzdanog proxy-ja (poslednja vrednost) ako je podešeno, inače TCP veza. */
function clientIp(req: IncomingMessage): string {
  const raw = IP_HEADER ? req.headers[IP_HEADER] : undefined;
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  const last = value?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "";
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
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
setInterval(() => void applyRetro().catch((e: Error) => console.warn(`naknadni shadow: ${e.message}`)), RETRO_MS).unref();
/** Članci portala (`onPost`): engine iz teksta meri koliko se komentari tiču članka. */
function announcePosts(k: Klaka): void {
  for (const p of POSTS) {
    k.onPost({
      post: p.id, rev: 1, url: `https://${PORTAL}/p/${p.id}`, title: p.title, section: p.section,
      body: p.paragraphs.join("\n\n"),
    });
  }
}
server.listen(PORT, () =>
  console.log(`demo portal na :${PORT} (klaka-api: ${API}, browser: ${API_PUBLIC}, događaji: ${events ? "da" : "ne"})`),
);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => void (events?.flush() ?? Promise.resolve()).finally(() => process.exit(0)));
    server.closeAllConnections();
  });
}
