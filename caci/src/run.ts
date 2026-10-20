// Izvođenje kampanje: poslušnici obe strane ogledala + legitimna publika, istovremeno.
// Svaka akcija se beleži (ground truth, docs/caci.md §7); ishod se čita tek iz baze (report.ts).

import { randomBytes } from "node:crypto";

import { chromium } from "playwright-core";

import { browserOperative } from "./browser.js";
import { Prefixes } from "./net.js";
import { sample, type Level, type Profile, type Role, type Side } from "./profile.js";

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

export interface RunLog {
  run: string;
  profile: Profile;
  portal: string;
  started_ms: number;
  ended_ms: number;
  actions: Action[];
}

// Lenj poslušnik: ista „obična" oznaka browsera za celu smenu.
const UA_SHIFT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_READERS = [
  UA_SHIFT,
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export async function run(profile: Profile, target: Target, avoid: ReadonlySet<string> = new Set()): Promise<RunLog> {
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const actions: Action[] = [];
  const nets = new Prefixes(Math.random, avoid);
  // Nivoi 2–3: jedan Chromium, poseban kontekst (kolačići, adresa) po poslušniku.
  const browser = profile.level >= 2 ? await chromium.launch() : null;
  const started = Date.now();

  const comments = await fetchComments(target);
  const postOf = new Map(comments.map((c) => [c.id, c.post]));
  for (const id of [...profile.targets.push, ...profile.targets.sink]) {
    if (!postOf.has(id)) throw new Error(`cilj ${id} nije javni komentar na portalu`);
  }
  const sides: Side[] = profile.mirror ? ["A", "B"] : ["A"];
  const tasks: Promise<void>[] = [];

  for (const side of sides) {
    // Strana B gura ono što A potiskuje i obrnuto.
    const { push, sink } = side === "A" ? profile.targets : { push: profile.targets.sink, sink: profile.targets.push };
    const cohort = Array.from({ length: profile.prefixes }, () => nets.take());
    for (const role of ["amplifier", "caci"] as const) {
      const goals = role === "amplifier" ? push : sink;
      const dir = role === "amplifier" ? 1 : -1;
      for (let i = 0; i < (profile.roles[role] ?? 0); i++) {
        const prefix = cohort[i % cohort.length]!;
        const actor = {
          id: `${side}-${role}-${i}`, role, side, level: profile.level, ip: nets.host(prefix),
          net: `${prefix}.0/24`, ua: UA_SHIFT,
        };
        tasks.push(
          (async () => {
            await sleep(Math.random() * profile.window_s * 1000);
            const plan = goals.map((id) => ({ id, post: postOf.get(id)! }));
            if (browser) await browserOperative(profile, target, actor, plan, dir, actions, browser);
            else await operative(profile, target, actor, plan, dir, actions);
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
        await sleep(Math.random() * profile.window_s * 1000);
        await read(profile, target, reader, comments, actions);
      })(),
    );
  }

  try {
    await Promise.all(tasks);
  } finally {
    await browser?.close();
  }
  return { run: runId, profile, portal: target.portal, started_ms: started, ended_ms: Date.now(), actions };
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
 * Poslušnik. Nivo 0: bez tokena. Nivo 1: jedan token po postu za ceo zadatak, ili
 * (`token_per_vote`) po jedan nov prikaz za svaki glas — svi uzeti odjednom, pa iskorišćeni
 * kad „sazru".
 */
async function operative(
  p: Profile, target: Target, a: Actor, goals: PortalComment[], dir: 1 | -1, log: Action[],
): Promise<void> {
  const plan = Array.from({ length: p.votes }, (_, n) => goals[n % goals.length]!);
  let tokens: (Token | null)[] = plan.map(() => null);
  if (p.level === 1) {
    if (p.token_per_vote) {
      tokens = await Promise.all(plan.map((g) => view(target, a, g.post)));
    } else {
      const perPost = new Map<string, Token | null>();
      for (const post of new Set(plan.map((g) => g.post))) perPost.set(post, await view(target, a, post));
      tokens = plan.map((g) => perPost.get(g.post)!);
    }
    await sleep(p.token_wait_ms);
  }
  for (let n = 0; n < plan.length; n++) {
    await vote(target, a, plan[n]!, dir, tokens[n]!, log);
    await sleep(sample(p.delay_ms));
  }
}

/** Koliko članaka pročita jedan čitalac: 1–3, najčešće jedan. */
const READER_POSTS = [1, 1, 1, 2, 2, 3];

/**
 * Čitalac: radi ono što radi pravi browser sa snippetom — za svaki članak koji pročita uzme
 * token, pošalje `view`, čita, pošalje `engage` (skrolovao je, video komentare) i ponekad glasa.
 */
async function read(p: Profile, target: Target, a: Actor, comments: PortalComment[], log: Action[]): Promise<void> {
  const posts = [...new Set(comments.map((c) => c.post))].sort(() => Math.random() - 0.5);
  for (const post of posts.slice(0, pick(READER_POSTS))) {
    const here = comments.filter((c) => c.post === post);
    const token = await view(target, a, post);
    if (token) await browserEvent(target, a, viewEvent(token, post));
    const readMs = sample(p.audience.read_ms);
    await sleep(readMs);
    const choice = pick(here);
    if (token) await browserEvent(target, a, engageEvent(token, readMs, here.map((c) => c.id), choice.id));
    if (Math.random() < p.audience.vote_p) {
      await vote(target, a, choice, Math.random() < 0.7 ? 1 : -1, token, log);
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

async function vote(
  target: Target, a: Actor, comment: PortalComment, dir: 1 | -1, token: Token | null, log: Action[],
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": a.ua,
    "X-Forwarded-For": a.ip,
  };
  if (token) headers["X-Klaka-Token"] = token.token;
  const t = Date.now();
  let status = 0;
  try {
    const res = await fetch(`${target.portalUrl}/api/vote`, {
      method: "POST", headers, body: JSON.stringify({ comment: comment.id, dir }),
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

async function fetchComments(target: Target): Promise<PortalComment[]> {
  const res = await fetch(`${target.portalUrl}/api/comments`);
  if (!res.ok) throw new Error(`portal ${target.portalUrl}: HTTP ${res.status}`);
  return ((await res.json()) as PortalComment[]).map(({ id, post }) => ({ id, post }));
}
