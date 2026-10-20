// Izvođenje kampanje: poslušnici obe strane ogledala + legitimna publika, istovremeno.
// Svaka akcija se beleži (ground truth, docs/caci.md §7); ishod se čita tek iz baze (report.ts).

import { randomBytes } from "node:crypto";

import { chromium } from "playwright-core";

import { browserOperative } from "./browser.js";
import { Prefixes } from "./net.js";
import { ROLES, sample, schedule, type Level, type Profile, type Role, type Side } from "./profile.js";
import { pseudonym, readerComment, templated, TEMPLATES, type Paraphraser } from "./texts.js";

export interface Target {
  portalUrl: string;
  apiUrl: string;
  collectorUrl: string;
  portal: string;
}

/** Javni komentar portala; `post` je članak na kome stoji. */
export interface PortalComment {
  id: string;
  post: string;
}

export interface Action {
  t: number;
  role: Role | "reader" | "cgnat";
  side: Side | null;
  level: Level | null;
  actor: string;
  net: string;
  vid: string | null;
  post: string;
  target: string;
  dir: 1 | -1;
  status: number;
}

export interface CommentAction {
  t: number;
  role: Role | "reader" | "cgnat";
  side: Side | null;
  level: Level | null;
  actor: string;
  net: string;
  vid: string | null;
  post: string;
  /** ID koji je portal dao komentaru (isti kao u `comment` događaju); `null` bez odgovora. */
  id: string | null;
  author: string;
  text: string;
  status: number;
}

export interface RunLog {
  run: string;
  profile: Profile;
  portal: string;
  started_ms: number;
  ended_ms: number;
  actions: Action[];
  comments: CommentAction[];
  /** Glasovi razvodnjivača koji nisu dati: još nema komentara druga sa strane, ili je u shadow. */
  skipped: number;
  /** Parafraze (nivo 4): koliko je traženo i koliko puta je ostao šablon. */
  paraphrase?: { asked: number; fallback: number };
}

/** Deljeno stanje jednog izvođenja. */
export interface Ctx {
  profile: Profile;
  target: Target;
  log: RunLog;
  /** Komentari razvodnjivača po strani — za njih glasaju ostali razvodnjivači te strane. */
  fellows: Map<Side, PortalComment[]>;
}

/** Zadatak poslušnika: glas za (ili protiv) komentara, ili komentar na članku. */
export type Task =
  | { kind: "vote"; goal: PortalComment | null; dir: 1 | -1 }
  | { kind: "comment"; post: string; text: string; author: string };

// Lenj poslušnik: ista „obična" oznaka browsera za celu smenu.
const UA_SHIFT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_READERS = [
  UA_SHIFT,
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
];
const PARAPHRASE_PARALLEL = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export async function run(
  profile: Profile, target: Target, avoid: ReadonlySet<string> = new Set(), paraphraser?: Paraphraser,
): Promise<RunLog> {
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const log: RunLog = {
    run: runId, profile, portal: target.portal, started_ms: 0, ended_ms: 0, actions: [], comments: [], skipped: 0,
  };
  const ctx: Ctx = { profile, target, log, fellows: new Map() };
  const nets = new Prefixes(Math.random, avoid);
  const comments = await fetchComments(target);
  const postOf = new Map(comments.map((c) => [c.id, c.post]));
  for (const id of [...profile.targets.push, ...profile.targets.sink]) {
    if (!postOf.has(id)) throw new Error(`cilj ${id} nije javni komentar na portalu`);
  }
  const posts = new Set(comments.map((c) => c.post));
  for (const post of profile.targets.dilute ?? []) {
    if (!posts.has(post)) throw new Error(`članak ${post} ne postoji na portalu`);
  }
  const sides: Side[] = profile.mirror ? ["A", "B"] : ["A"];
  // Tekstovi se spremaju pre početka — kao spisak koji poslušnici dobiju za smenu.
  const texts = await prepareTexts(profile, sides.length, log, paraphraser);

  // Nivoi 2–4: jedan Chromium, poseban kontekst (kolačići, adresa) po poslušniku.
  const browser = profile.level >= 2 ? await chromium.launch() : null;
  log.started_ms = Date.now();
  const tasks: Promise<void>[] = [];

  for (const side of sides) {
    // Strana B gura ono što A potiskuje i obrnuto.
    const { push, sink } = side === "A" ? profile.targets : { push: profile.targets.sink, sink: profile.targets.push };
    const cohort = Array.from({ length: profile.prefixes }, () => nets.take());
    for (const role of ROLES) {
      const goals = (role === "amplifier" ? push : role === "caci" ? sink : []).map((id) => ({ id, post: postOf.get(id)! }));
      const count = profile.roles[role] ?? 0;
      for (let i = 0; i < count; i++) {
        const prefix = cohort[i % cohort.length]!;
        const actor: Actor = {
          id: `${side}-${role}-${i}`, role, side, level: profile.level, ip: nets.host(prefix),
          net: `${prefix}.0/24`, ua: UA_SHIFT,
        };
        const plan = operativePlan(profile, role, goals, texts[role].next(), i);
        // Smene (nivo 4): poslušnik radi samo u svojoj smeni i staje kad se ona završi. Smene su
        // uzastopni blokovi poslušnika, pa svaka radi iz istih prefiksa kohorte (ista kancelarija).
        const shift = profile.shifts ? Math.floor((i * profile.shifts.count) / count) : 0;
        const startMs = shift * (profile.shifts?.duration_s ?? 0) * 1000;
        const endMs = profile.shifts ? startMs + profile.shifts.duration_s * 1000 : Infinity;
        tasks.push(
          (async () => {
            await sleep(startMs + Math.random() * profile.window_s * 1000);
            const deadline = log.started_ms + endMs;
            if (browser) await browserOperative(ctx, actor, plan, deadline, browser);
            else await operative(ctx, actor, plan, deadline);
          })(),
        );
      }
    }
  }

  // Legitimni blizanac (koncept §8): mnogo pravih čitalaca iza jednog prefiksa (CGNAT, firma).
  const cgnat = nets.take();
  const twins = profile.audience.cgnat ?? 0;
  for (let i = 0; i < profile.audience.readers + twins; i++) {
    const twin = i >= profile.audience.readers;
    const prefix = twin ? cgnat : nets.take();
    const reader = {
      id: twin ? `cgnat-${i}` : `reader-${i}`, role: twin ? ("cgnat" as const) : ("reader" as const),
      side: null, level: null, ip: nets.host(prefix), net: `${prefix}.0/24`, ua: pick(UA_READERS),
    };
    tasks.push(
      (async () => {
        await sleep(Math.random() * runSpan(profile) * 1000);
        await read(ctx, reader, comments);
      })(),
    );
  }

  try {
    await Promise.all(tasks);
  } finally {
    await browser?.close();
  }
  log.ended_ms = Date.now();
  return log;
}

/** Koliko traje kampanja (sve smene); publika dolazi tokom celog tog vremena. */
function runSpan(p: Profile): number {
  return p.shifts ? (p.shifts.count - 1) * p.shifts.duration_s + p.window_s : p.window_s;
}

/** Zadaci jednog poslušnika: glasovi i komentari, izmešani (`schedule`). */
export function operativePlan(
  p: Profile, role: Role, goals: PortalComment[], texts: string[], index: number,
): Task[] {
  const names = Array.from({ length: p.pseudonyms ?? 1 }, () => pseudonym());
  const dir: 1 | -1 = role === "caci" ? -1 : 1;
  // Komentari idu na članke ciljeva (razvodnjivači: na članke koje zatrpavaju).
  const commentPosts = role === "diluter" ? p.targets.dilute! : [...new Set(goals.map((g) => g.post))];
  let votes = 0;
  let comments = 0;
  return schedule(p.votes, texts.length).map((kind): Task => {
    if (kind === "vote") {
      const goal = role === "diluter" ? null : goals[votes++ % goals.length]!;
      return { kind, goal, dir };
    }
    const n = comments++;
    return {
      kind, post: commentPosts[(index + n) % commentPosts.length]!, text: texts[n]!, author: names[n % names.length]!,
    };
  });
}

interface TextSource {
  /** Tekstovi za sledećeg poslušnika ove uloge. */
  next(): string[];
}

/** Po `comments` tekstova za svakog poslušnika svake uloge: šabloni ili njihove parafraze. */
async function prepareTexts(
  p: Profile, sides: number, log: RunLog, paraphraser?: Paraphraser,
): Promise<Record<Role, TextSource>> {
  const per = p.comments ?? 0;
  const out = {} as Record<Role, TextSource>;
  for (const role of ROLES) {
    const templates = p.templates?.[role] ?? TEMPLATES[role];
    const operatives = (p.roles[role] ?? 0) * sides;
    // Svaki poslušnik kreće od drugog šablona, pa ni bez parafraze nisu svi isti.
    let pool = Array.from({ length: operatives }, (_, i) => templated(templates, per, i)).flat();
    if (p.paraphrase && pool.length) {
      if (!paraphraser) throw new Error("profil traži parafraze, a Ollama nije podešen (CACI_OLLAMA_URL)");
      pool = await paraphraseAll(pool, paraphraser, log);
    }
    let i = 0;
    out[role] = { next: () => pool.slice(per * i, per * ++i) };
  }
  return out;
}

async function paraphraseAll(texts: string[], paraphraser: Paraphraser, log: RunLog): Promise<string[]> {
  const stats = (log.paraphrase ??= { asked: 0, fallback: 0 });
  const out = texts.slice();
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      stats.asked++;
      const text = await paraphraser.paraphrase(texts[i]!).catch(() => null);
      if (text) out[i] = text;
      else stats.fallback++;
    }
  };
  await Promise.all(Array.from({ length: PARAPHRASE_PARALLEL }, worker));
  return out;
}

export interface Actor {
  id: string;
  role: Role | "reader" | "cgnat";
  side: Side | null;
  level: Level | null;
  ip: string;
  net: string;
  ua: string;
}

/**
 * Poslušnik bez browsera. Nivo 0: bez tokena. Nivo 1: jedan token po postu za ceo zadatak,
 * ili (`token_per_vote`) po jedan nov prikaz za svaku akciju — svi uzeti odjednom, pa
 * iskorišćeni kad „sazru".
 */
async function operative(ctx: Ctx, a: Actor, plan: Task[], deadline: number): Promise<void> {
  const p = ctx.profile;
  const postOfTask = (t: Task) => (t.kind === "comment" ? t.post : t.goal?.post ?? p.targets.dilute![0]!);
  let tokens: (Token | null)[] = plan.map(() => null);
  if (p.level === 1) {
    if (p.token_per_vote) {
      tokens = await Promise.all(plan.map((t) => view(ctx.target, a, postOfTask(t))));
    } else {
      const perPost = new Map<string, Token | null>();
      for (const post of new Set(plan.map(postOfTask))) perPost.set(post, await view(ctx.target, a, post));
      tokens = plan.map((t) => perPost.get(postOfTask(t))!);
    }
    await sleep(p.token_wait_ms);
  }
  for (let n = 0; n < plan.length && Date.now() < deadline; n++) {
    const task = plan[n]!;
    if (task.kind === "comment") {
      const id = await comment(ctx, a, task, tokens[n]!);
      if (id && a.role === "diluter") fellowsOf(ctx, a).push({ id, post: task.post });
    } else {
      const goal = task.goal ?? (await fellowGoal(ctx, a));
      if (goal) await vote(ctx.target, a, goal, task.dir, tokens[n]!, ctx.log.actions);
      else ctx.log.skipped++;
    }
    await sleep(sample(p.delay_ms));
  }
}

export function fellowsOf(ctx: Ctx, a: Actor): PortalComment[] {
  const side = a.side ?? "A";
  let list = ctx.fellows.get(side);
  if (!list) ctx.fellows.set(side, (list = []));
  return list;
}

/** Komentar drugog razvodnjivača iste strane koji je javno vidljiv; `null` ako ga nema. */
async function fellowGoal(ctx: Ctx, a: Actor): Promise<PortalComment | null> {
  const own = new Set(ctx.log.comments.filter((c) => c.actor === a.id).map((c) => c.id));
  const candidates = fellowsOf(ctx, a).filter((c) => !own.has(c.id));
  if (candidates.length === 0) return null;
  const goal = pick(candidates);
  // Shadow komentar se ne vidi, pa za njega ne može ni da se glasa.
  const visible = await fetchComments(ctx.target, goal.post).catch(() => []);
  return visible.some((c) => c.id === goal.id) ? goal : null;
}

/** Koliko članaka pročita jedan čitalac: 1–3, najčešće jedan. */
const READER_POSTS = [1, 1, 1, 2, 2, 3];

/**
 * Čitalac: radi ono što radi pravi browser sa snippetom — za svaki članak koji pročita uzme
 * token, pošalje `view`, čita, ponekad napiše komentar (`compose`, pa komentar), pošalje
 * `engage` (skrolovao je, video komentare) i ponekad glasa.
 */
async function read(ctx: Ctx, a: Actor, comments: PortalComment[]): Promise<void> {
  const p = ctx.profile;
  const target = ctx.target;
  const author = pseudonym();
  const posts = [...new Set(comments.map((c) => c.post))].sort(() => Math.random() - 0.5);
  for (const post of posts.slice(0, pick(READER_POSTS))) {
    const here = comments.filter((c) => c.post === post);
    const token = await view(target, a, post);
    if (token) await browserEvent(target, a, viewEvent(token, post));
    const readMs = sample(p.audience.read_ms);
    await sleep(readMs);
    if (Math.random() < (p.audience.comment_p ?? 0)) {
      const text = readerComment();
      // Kucanje: oko 200 ms po znaku, uz poneku ispravku.
      const typingMs = Math.round(text.length * 200 * (0.8 + Math.random() * 0.6));
      await sleep(typingMs);
      if (token) await browserEvent(target, a, composeEvent(token, post, text, typingMs));
      await comment(ctx, a, { kind: "comment", post, text, author }, token);
    }
    const choice = pick(here);
    if (token) await browserEvent(target, a, engageEvent(token, readMs, here.map((c) => c.id), choice.id));
    if (Math.random() < p.audience.vote_p) {
      await vote(target, a, choice, Math.random() < 0.7 ? 1 : -1, token, ctx.log.actions);
    }
  }
}

function viewEvent(tok: Token, post: string): Record<string, unknown> {
  return {
    type: "view", vid: tok.vid, t: Date.now(), post, ref: pick([null, "https://www.google.com/"]),
    variant: null, lang: pick(["en-US", "de-DE", "fr-FR"]), tz_min: 60, vp: pick([[1300, 700], [400, 800], [1900, 1000]]),
    auto: 0,
  };
}

function engageEvent(tok: Token, readMs: number, comments: string[], voted: string): Record<string, unknown> {
  const dwell = Math.round(readMs);
  const hist = Array.from({ length: 10 }, (_, i) => Math.round((dwell * (10 - i)) / 55));
  return {
    type: "engage", vid: tok.vid, t: Date.now(), dwell_ms: dwell, visible_ms: Math.round(dwell * 0.9),
    depth_max: 700 + Math.floor(Math.random() * 301), depth_hist: hist, jumps: 0,
    first_input_ms: Math.round(dwell * 0.1), inputs: { key: 0, ptr: 3 + Math.floor(Math.random() * 10), touch: 0 },
    comments_ms: Math.round(dwell * 0.6), seq: 0, seen: [...new Set([...comments.slice(0, 2), voted])],
  };
}

/** Kao `compose` iz snippeta (events.md §2): samo opsezi, kucano bez lepljenja. */
function composeEvent(tok: Token, post: string, text: string, focusMs: number): Record<string, unknown> {
  const keys = Math.round(text.length * (1.05 + Math.random() * 0.15));
  return {
    type: "compose", vid: tok.vid, t: Date.now(), post, focus_ms: focusMs,
    keys: keys <= 10 ? "1-10" : keys <= 50 ? "11-50" : keys <= 200 ? "51-200" : "200+",
    pasted: false, pasted_chars: "0",
    length: text.length <= 50 ? "1-50" : text.length <= 200 ? "51-200" : "201-1000",
  };
}

/** Kao `sendBeacon` iz snippeta: `text/plain` na collector, sa adresom čitaoca. */
async function browserEvent(target: Target, a: Actor, event: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${target.collectorUrl}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Forwarded-For": a.ip, "User-Agent": a.ua },
      body: JSON.stringify({ v: 1, portal: target.portal, sent_ms: Date.now(), events: [event] }),
    });
    await res.body?.cancel();
  } catch {
    // kao i beacon: neuspeh se ne ponavlja
  }
}

interface Token {
  token: string;
  vid: string;
}

async function view(target: Target, a: Actor, post: string): Promise<Token | null> {
  const res = await fetch(`${target.apiUrl}/v1/view`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Forwarded-For": a.ip },
    body: JSON.stringify({ portal: target.portal, post }),
  });
  return res.ok ? ((await res.json()) as Token) : null;
}

function headersFor(a: Actor, token: Token | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": a.ua,
    "X-Forwarded-For": a.ip,
  };
  if (token) headers["X-Klaka-Token"] = token.token;
  return headers;
}

async function vote(
  target: Target, a: Actor, comment: PortalComment, dir: 1 | -1, token: Token | null, log: Action[],
): Promise<void> {
  const t = Date.now();
  let status = 0;
  try {
    const res = await fetch(`${target.portalUrl}/api/vote`, {
      method: "POST", headers: headersFor(a, token), body: JSON.stringify({ comment: comment.id, dir }),
    });
    status = res.status;
    await res.body?.cancel();
  } catch {
    // status 0: portal nije odgovorio
  }
  log.push({
    t, role: a.role, side: a.side, level: a.level, actor: a.id, net: a.net,
    vid: token?.vid ?? null, post: comment.post, target: comment.id, dir, status,
  });
}

/** Komentar preko API-ja portala (nivoi 0–1 i publika); vraća ID koji je portal dao. */
async function comment(
  ctx: Ctx, a: Actor, task: Extract<Task, { kind: "comment" }>, token: Token | null,
): Promise<string | null> {
  const t = Date.now();
  let status = 0;
  let id: string | null = null;
  try {
    const res = await fetch(`${ctx.target.portalUrl}/api/comment`, {
      method: "POST", headers: headersFor(a, token),
      body: JSON.stringify({ post: task.post, author: task.author, text: task.text }),
    });
    status = res.status;
    id = res.ok ? ((await res.json()) as { id?: string }).id ?? null : null;
  } catch {
    // status 0: portal nije odgovorio
  }
  ctx.log.comments.push({
    t, role: a.role, side: a.side, level: a.level, actor: a.id, net: a.net, vid: token?.vid ?? null,
    post: task.post, id, author: task.author, text: task.text, status,
  });
  return id;
}

/** Javni komentari portala (svi ili jednog članka). */
export async function fetchComments(target: Target, post?: string): Promise<PortalComment[]> {
  const res = await fetch(`${target.portalUrl}/api/comments${post ? `?post=${encodeURIComponent(post)}` : ""}`);
  if (!res.ok) throw new Error(`portal ${target.portalUrl}: HTTP ${res.status}`);
  return ((await res.json()) as PortalComment[]).map(({ id, post }) => ({ id, post }));
}
