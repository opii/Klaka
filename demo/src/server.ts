// Portal: naslovna, rubrike, članci, komentari sa odgovorima, glasanje. Bez framework-a, samo
// node:http; stanje u bazi `portal` (PostgreSQL, odvojena od Klakine).
//
// Okruženje:
//   PORT                 (3000)
//   PORTAL_POSTGRES_URL    baza portala; pravi je ako ne postoji (postgres://…/portal)
//   PORTAL_CID_SALT        so za `cid` prijavljenih (sdk.md §4); bez nje razvojna vrednost
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

import { EventSender, Klaka, cidOf, type Policy } from "@klaka/sdk-node";

import { checkPassword, hashPassword } from "./auth.js";

import { POSTS, SECTIONS, SEED_COMMENTS } from "./content.js";
import { Db, type Account, type Comment, type Viewer } from "./db.js";
import { accountPage, adminPage, articlePage, homePage, sectionPage } from "./page.js";
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

const CID_SALT = env.PORTAL_CID_SALT || "demo-cid-salt";
if (!env.PORTAL_CID_SALT) console.warn("PORTAL_CID_SALT nije postavljen — razvojna so za cid");

/**
 * Komentar je vidljiv posetiocu ako je javan ili njegov — sa ovog uređaja ili, prijavljenom,
 * sa naloga (shadow komentar vidi samo autor).
 */
const visible = (c: Comment, v: Viewer) =>
  c.decision === "count" || (v.sid !== null && c.owner === v.sid) || (v.account !== null && c.account === v.account);

/** Posetilac: kolačić (nov, ako ga nema — `Set-Cookie` ide u `headers`) i nalog, ako je prijavljen. */
async function visitor(req: IncomingMessage, headers: Record<string, string>): Promise<Viewer & { user: Account | null }> {
  const sid = cookie(req, SID) ?? newSid(headers);
  const user = await db.accountOfSession(sid);
  return { sid, account: user?.id ?? null, user };
}

/** `cid` prijavljenog posetioca (sdk.md §4); anonimni ga nemaju. */
const cidOfAccount = (account: number | null) => (account === null ? null : cidOf(CID_SALT, `account:${account}`));

/**
 * Zbirovi kako ih vidi posetilac: javni zbir plus njegovi shadow glasovi (sdk.md §2) — inače
 * posle osvežavanja vidi da mu glas nije uračunat. Ostali vide samo javni zbir.
 */
async function asSeenBy(list: Comment[], viewer: Viewer, post: string | null): Promise<Comment[]> {
  if (viewer.sid === null && viewer.account === null) return list;
  const own = await db.ownShadowDeltas(viewer, post);
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
  const viewer = await visitor(req, headers);
  // Komentar koji posetilac ne vidi (tuđ shadow) ne postoji za njega.
  const comment = typeof body?.comment === "string" ? await db.comment(body.comment) : null;
  const dir = body?.dir;
  if (!comment || !visible(comment, viewer) || (dir !== 1 && dir !== -1)) {
    return send(res, 400, "application/json", '{"ok":false}');
  }

  const now = Date.now();
  // Bez ključeva (klaka-api nedostupan pri startu) nijedan token ne može da se proveri.
  const r = klaka
    ? await klaka.onVote(clientRequest(req, cidOfAccount(viewer.account)), {
        post: comment.post, target: comment.id, targetAuthor: comment.author, dir,
      })
    : { decision: "shadow" as const, vid: null, token: "unknown_key" as const, uses: null, repeat: null };
  await db.insertVote({
    t: now, owner: viewer.sid, post: comment.post, comment: comment.id, dir, vid: r.vid, token: r.token, uses: r.uses,
    repeat: r.repeat, decision: r.decision, retro: false, account: viewer.account,
  });

  // Isti odgovor za count i shadow (spec README, princip 3).
  send(res, 200, "application/json", '{"ok":true}', headers);
}

async function comment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const post = POSTS.find((p) => p.id === body?.post);
  const headers: Record<string, string> = {};
  const viewer = await visitor(req, headers);
  // Prijavljen komentariše pod pseudonimom naloga; anonimni ne sme pod tuđim registrovanim.
  const author = viewer.user?.pseudonym ?? (typeof body?.author === "string" ? body.author.trim() : "");
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!post || !author || author.length > MAX_AUTHOR || !text || text.length > MAX_TEXT) {
    return send(res, 400, "application/json", '{"ok":false}');
  }
  if (!viewer.user && (await db.pseudonymTaken(author))) {
    return send(res, 400, "application/json", '{"ok":false,"error":"zauzeto"}', headers);
  }
  // Odgovor samo na komentar istog članka koji posetilac vidi.
  let replyTo: string | null = null;
  if (typeof body?.reply_to === "string" && body.reply_to) {
    const parent = await db.comment(body.reply_to);
    if (!parent || parent.post !== post.id || !visible(parent, viewer)) return send(res, 400, "application/json", '{"ok":false}');
    replyTo = parent.id;
  }
  const id = await db.nextCommentId();
  const r = klaka
    ? await klaka.onComment(clientRequest(req, cidOfAccount(viewer.account)), { post: post.id, comment: id, author, text, replyTo })
    : { decision: "shadow" as const, token: "unknown_key" as const };
  await db.insertComment({
    id, post: post.id, reply_to: replyTo, author, text, score: 0, t: Date.now(), decision: r.decision, owner: viewer.sid,
    token: r.token, retro: false, account: viewer.account,
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
  const viewer = await visitor(req, headers);
  const sort: Sort = SORTS.find((s) => s === url.searchParams.get("sort")) ?? "najbolji";
  const list = await asSeenBy(await db.visibleComments(post.id, viewer), viewer, post.id);
  const all = threads(list, sort);
  // Trajni link na komentar (`?komentar=`) otvara stranicu na kojoj je; inače `?strana=`.
  const linked = url.searchParams.get("komentar");
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const asked = Number(url.searchParams.get("strana") ?? 1);
  const page = linked ? pageOf(all, linked) : Number.isInteger(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
  send(res, 200, "text/html; charset=utf-8",
    articlePage({
      user: viewer.user, apiPublic: API_PUBLIC, collectorPublic: COLLECTOR_PUBLIC, portal: PORTAL, post, threads: all,
      total: list.length, sort, page,
    }), headers);
}

async function publicComments(req: IncomingMessage, post: string | null): Promise<object[]> {
  const sid = cookie(req, SID);
  const viewer = { sid, account: sid ? ((await db.accountOfSession(sid))?.id ?? null) : null };
  return (await asSeenBy(await db.visibleComments(post, viewer), viewer, post))
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
      if (req.method === "GET" && url.pathname.startsWith("/r/")) return section(req, res, url.pathname.slice(3));
      switch (route) {
        case "GET /":
          return home(req, res);
        case "GET /prijava":
        case "GET /registracija":
          return accountForm(req, res, url);
        case "POST /prijava":
        case "POST /registracija":
          return accountSubmit(req, res, url.pathname === "/prijava" ? "prijava" : "registracija");
        case "POST /odjava":
          return logout(req, res);
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

async function home(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  const { user } = await visitor(req, headers);
  send(res, 200, "text/html; charset=utf-8",
    homePage({ portal: PORTAL, user, posts: POSTS, comments: await db.publicCounts() }), headers);
}

async function section(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  const s = SECTIONS.find((x) => x.slug === decodeURIComponent(slug));
  if (!s) return send(res, 404, "text/plain", "nema");
  const headers: Record<string, string> = {};
  const { user } = await visitor(req, headers);
  const posts = POSTS.filter((p) => p.section === s.id);
  send(res, 200, "text/html; charset=utf-8",
    sectionPage({ portal: PORTAL, user, section: s.id, name: s.name, posts, comments: await db.publicCounts() }), headers);
}

// --- nalozi ---------------------------------------------------------------------------------

const PSEUDONYM = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,38}[\p{L}\p{N}]$/u;
const MIN_PASSWORD = 8;

/** Povratak posle prijave: samo putanja ovog portala, ne tuđa adresa. */
const safeNext = (next: string | null | undefined) => (next && /^\/(?!\/)/.test(next) ? next : "/");

async function accountForm(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const headers: Record<string, string> = {};
  const { user } = await visitor(req, headers);
  const mode = url.pathname === "/prijava" ? "prijava" : "registracija";
  send(res, 200, "text/html; charset=utf-8",
    accountPage({ portal: PORTAL, user, mode, next: safeNext(url.searchParams.get("next")) }), headers);
}

async function accountSubmit(req: IncomingMessage, res: ServerResponse, mode: "prijava" | "registracija"): Promise<void> {
  const form = await readForm(req);
  const pseudonym = (form?.get("pseudonym") ?? "").trim();
  const password = form?.get("password") ?? "";
  const next = safeNext(form?.get("next"));
  const fail = (error: string) =>
    send(res, 400, "text/html; charset=utf-8", accountPage({ portal: PORTAL, user: null, mode, next, error }));
  let account: Account | null = null;
  if (mode === "registracija") {
    if (!PSEUDONYM.test(pseudonym)) return fail("Pseudonim: 3–40 slova ili cifara (razmak, tačka, crtica u sredini).");
    if (password.length < MIN_PASSWORD) return fail(`Lozinka: bar ${MIN_PASSWORD} znakova.`);
    account = await db.createAccount(pseudonym, await hashPassword(password));
    if (!account) return fail("Pseudonim je zauzet.");
  } else {
    const found = await db.accountByPseudonym(pseudonym);
    // Ista poruka za nepostojeći nalog i pogrešnu lozinku.
    if (!found || !(await checkPassword(password, found.password))) return fail("Pogrešan pseudonim ili lozinka.");
    account = found;
  }
  const headers: Record<string, string> = { Location: next };
  const sid = newSid(headers);
  await db.startSession(cookie(req, SID), sid, account.id);
  send(res, 303, "text/plain", "", headers);
}

async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sid = cookie(req, SID);
  if (sid) await db.endSession(sid);
  // Posle odjave nov kolačić: akcije pod nalogom ostaju nalogu, ne ovom uređaju.
  const headers: Record<string, string> = { Location: "/" };
  newSid(headers);
  send(res, 303, "text/plain", "", headers);
}

function clientRequest(req: IncomingMessage, cid: string | null) {
  const header = req.headers["x-klaka-token"];
  return { token: Array.isArray(header) ? header[0] : header, ip: clientIp(req), ua: req.headers["user-agent"], cid };
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

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Klasična HTML forma (`application/x-www-form-urlencoded`). */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const body = await readBody(req);
  return body === null ? null : new URLSearchParams(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  if (body === null) return null;
  try {
    const v: unknown = JSON.parse(body);
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
