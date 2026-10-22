// Portal: naslovna, rubrike, članci, komentari sa odgovorima, glasanje. Bez framework-a, samo
// node:http; stanje u bazi `portal` (PostgreSQL, odvojena od Klakine).
//
// Okruženje:
//   PORT                 (3000)
//   PORTAL_POSTGRES_URL    baza portala; pravi je ako ne postoji (postgres://…/portal)
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

import { POSTS, SECTIONS, SEED_COMMENTS } from "./content.js";
import { Db, type Comment } from "./db.js";
import { adminPage, articlePage, homePage, sectionPage } from "./page.js";
import { pageOf, PAGE, SORTS, threads, type Sort } from "./thread.js";
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

if (!env.PORTAL_POSTGRES_URL) throw new Error("PORTAL_POSTGRES_URL nije postavljen");
const db = await Db.open(env.PORTAL_POSTGRES_URL);
// Početni komentari su stariji od svih pravih (sort „najnoviji").
await db.seed(SEED_COMMENTS, Date.parse("2026-10-01T08:00:00Z"));

/** Komentar je vidljiv posetiocu ako je javan ili njegov (shadow komentar vidi samo autor). */
const visible = (c: Comment, sid: string | null) => c.decision === "count" || (sid !== null && c.owner === sid);

/**
 * Zbirovi kako ih vidi posetilac: javni zbir plus njegovi shadow glasovi (sdk.md §2) — inače
 * posle osvežavanja vidi da mu glas nije uračunat. Ostali vide samo javni zbir.
 */
async function asSeenBy(list: Comment[], sid: string | null, post: string | null): Promise<Comment[]> {
  if (sid === null) return list;
  const own = await db.ownShadowDeltas(sid, post);
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
  const comment = typeof body?.comment === "string" ? await db.comment(body.comment) : null;
  const dir = body?.dir;
  if (!comment || !visible(comment, sid) || (dir !== 1 && dir !== -1)) {
    return send(res, 400, "application/json", '{"ok":false}');
  }

  const now = Date.now();
  // Bez ključeva (klaka-api nedostupan pri startu) nijedan token ne može da se proveri.
  const r = klaka
    ? await klaka.onVote(clientRequest(req), { post: comment.post, target: comment.id, targetAuthor: comment.author, dir })
    : { decision: "shadow" as const, vid: null, token: "unknown_key" as const, uses: null, repeat: null };
  await db.insertVote({
    t: now, owner: sid, post: comment.post, comment: comment.id, dir, vid: r.vid, token: r.token, uses: r.uses,
    repeat: r.repeat, decision: r.decision, retro: false,
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
  // Odgovor samo na komentar istog članka koji posetilac vidi.
  let replyTo: string | null = null;
  if (typeof body?.reply_to === "string" && body.reply_to) {
    const parent = await db.comment(body.reply_to);
    if (!parent || parent.post !== post.id || !visible(parent, sid)) return send(res, 400, "application/json", '{"ok":false}');
    replyTo = parent.id;
  }
  const id = await db.nextCommentId();
  const r = klaka
    ? await klaka.onComment(clientRequest(req), { post: post.id, comment: id, author, text, replyTo })
    : { decision: "shadow" as const, token: "unknown_key" as const };
  await db.insertComment({
    id, post: post.id, reply_to: replyTo, author, text, score: 0, t: Date.now(), decision: r.decision, owner: sid,
    token: r.token, retro: false,
  });

  // Isti odgovor za count i shadow: autor svoj komentar vidi u oba slučaja.
  send(res, 200, "application/json", JSON.stringify({ ok: true, id }), headers);
}

// Naknadni shadow (sdk.md §2b): akcije koje je engine uz presudu poslao da se skinu. Kursor je u
// bazi portala, pa restart nastavlja odakle je stao.
const RETRO_MS = 2_000;
const RETRO_CURSOR = "retro_cursor";

async function applyRetro(): Promise<void> {
  if (!klaka) return;
  const after = (await db.getState(RETRO_CURSOR)) ?? "0-0";
  const { cursor, actions } = await klaka.retro(after);
  // Idempotentno: već skinuta ili nepoznata akcija se preskače.
  for (const a of actions) {
    if (a.kind === "comment") await db.retroComment(a.comment);
    else await db.retroVote(a.vid, a.target);
  }
  if (cursor !== after) await db.setState(RETRO_CURSOR, cursor);
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

async function article(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
  const post = POSTS.find((p) => p.id === id);
  if (!post) return send(res, 404, "text/plain", "nema");
  const headers: Record<string, string> = {};
  const sid = cookie(req, SID) ?? newSid(headers);
  const sort: Sort = SORTS.find((s) => s === url.searchParams.get("sort")) ?? "najbolji";
  const list = await asSeenBy(await db.visibleComments(post.id, sid), sid, post.id);
  const all = threads(list, sort);
  // Trajni link na komentar (`?komentar=`) otvara stranicu na kojoj je; inače `?strana=`.
  const linked = url.searchParams.get("komentar");
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const asked = Number(url.searchParams.get("strana") ?? 1);
  const page = linked ? pageOf(all, linked) : Number.isInteger(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
  send(res, 200, "text/html; charset=utf-8",
    articlePage({
      apiPublic: API_PUBLIC, collectorPublic: COLLECTOR_PUBLIC, portal: PORTAL, post, threads: all, total: list.length,
      sort, page,
    }), headers);
}

async function publicComments(req: IncomingMessage, post: string | null): Promise<object[]> {
  const sid = cookie(req, SID);
  return (await asSeenBy(await db.visibleComments(post, sid), sid, post))
    .map(({ id, post, reply_to, author, text, score }) => ({ id, post, reply_to, author, text, score }));
}

async function admin(url: URL, res: ServerResponse, what: "html" | "votes" | "comments"): Promise<void> {
  const limit = 1_000;
  if (what === "votes") return send(res, 200, "application/json", JSON.stringify(await db.lastVotes(limit)));
  if (what === "comments") {
    // `?id=` za jedan komentar (javni brojač u e2e), inače poslednjih 1000.
    const id = url.searchParams.get("id");
    const list = id ? [await db.comment(id)].filter(Boolean) : await db.lastComments(limit);
    return send(res, 200, "application/json", JSON.stringify(list));
  }
  send(res, 200, "text/html; charset=utf-8",
    adminPage({ portal: PORTAL, votes: await db.lastVotes(200), comments: await db.lastComments(200) }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://demo");
  const route = `${req.method} ${url.pathname}`;
  Promise.resolve()
    .then(() => {
      if (req.method === "GET" && url.pathname.startsWith("/p/")) return article(req, res, url.pathname.slice(3), url);
      if (req.method === "GET" && url.pathname.startsWith("/r/")) return section(res, url.pathname.slice(3));
      switch (route) {
        case "GET /":
          return db.publicCounts().then((comments) =>
            send(res, 200, "text/html; charset=utf-8", homePage({ portal: PORTAL, posts: POSTS, comments })));
        case "GET /klaka.min.js":
          return send(res, 200, "text/javascript; charset=utf-8", snippet);
        case "POST /api/vote":
          return vote(req, res);
        case "POST /api/comment":
          return comment(req, res);
        case "GET /api/posts":
          return send(res, 200, "application/json", JSON.stringify(POSTS.map(({ id, title }) => ({ id, title }))));
        case "GET /api/comments":
          return publicComments(req, url.searchParams.get("post")).then((list) =>
            send(res, 200, "application/json", JSON.stringify(list)));
        case "GET /admin":
          return admin(url, res, "html");
        case "GET /admin/votes.json":
          return admin(url, res, "votes");
        case "GET /admin/comments.json":
          return admin(url, res, "comments");
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

async function section(res: ServerResponse, slug: string): Promise<void> {
  const s = SECTIONS.find((x) => x.slug === decodeURIComponent(slug));
  if (!s) return send(res, 404, "text/plain", "nema");
  const posts = POSTS.filter((p) => p.section === s.id);
  send(res, 200, "text/html; charset=utf-8",
    sectionPage({ portal: PORTAL, section: s.id, name: s.name, posts, comments: await db.publicCounts() }));
}

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
    server.close(() =>
      void (events?.flush() ?? Promise.resolve()).finally(() => void db.close().finally(() => process.exit(0))),
    );
    server.closeAllConnections();
  });
}
