// Izvođenje kampanje: poslušnici obe strane ogledala + legitimna publika, istovremeno.
// Svaka akcija se beleži (ground truth, docs/caci.md §7); ishod se čita tek iz baze (report.ts).

import { randomBytes } from "node:crypto";

import { Prefixes } from "./net.js";
import { sample, type Level, type Profile, type Role, type Side } from "./profile.js";

export interface Target {
  portalUrl: string;
  apiUrl: string;
  collectorUrl: string;
  portal: string;
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
  target: string;
  dir: 1 | -1;
  status: number;
}

export interface RunLog {
  run: string;
  profile: Profile;
  portal: string;
  post: string;
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
  const started = Date.now();

  const comments = await fetchComments(target);
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
            await operative(profile, target, actor, goals, dir, actions);
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

  await Promise.all(tasks);
  return { run: runId, profile, portal: target.portal, post: target.post, started_ms: started, ended_ms: Date.now(), actions };
}

interface Actor {
  id: string;
  role: Role | "reader" | "cgnat";
  side: Side | null;
  level: Level | null;
  ip: string;
  net: string;
  ua: string;
}

/**
 * Poslušnik. Nivo 0: bez tokena. Nivo 1: jedan token za ceo zadatak, ili (`token_per_vote`)
 * po jedan nov prikaz za svaki glas — svi uzeti odjednom, pa iskorišćeni kad „sazru".
 */
async function operative(
  p: Profile, target: Target, a: Actor, goals: string[], dir: 1 | -1, log: Action[],
): Promise<void> {
  let tokens: (Token | null)[] = Array<Token | null>(p.votes).fill(null);
  if (p.level === 1) {
    if (p.token_per_vote) {
      tokens = await Promise.all(tokens.map(() => view(target, a)));
    } else {
      tokens.fill(await view(target, a));
    }
    await sleep(p.token_wait_ms);
  }
  for (let n = 0; n < p.votes; n++) {
    await vote(target, a, goals[n % goals.length]!, dir, tokens[n]!, log);
    await sleep(sample(p.delay_ms));
  }
}

/**
 * Čitalac: radi ono što radi pravi browser sa snippetom — uzme token, pošalje `view`, čita,
 * pošalje `engage` (skrolovao je, video komentare) i ponekad glasa.
 */
async function read(p: Profile, target: Target, a: Actor, comments: string[], log: Action[]): Promise<void> {
  const token = await view(target, a);
  if (token) await browserEvent(target, a, viewEvent(token, target));
  const readMs = sample(p.audience.read_ms);
  await sleep(readMs);
  const choice = pick(comments);
  if (token) await browserEvent(target, a, engageEvent(token, readMs, comments, choice));
  if (Math.random() < p.audience.vote_p) {
    await vote(target, a, choice, Math.random() < 0.7 ? 1 : -1, token, log);
  }
}

function viewEvent(tok: Token, target: Target): Record<string, unknown> {
  return {
    type: "view", vid: tok.vid, t: Date.now(), post: target.post, ref: pick([null, "https://www.google.com/"]),
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

async function view(target: Target, a: Actor): Promise<Token | null> {
  const res = await fetch(`${target.apiUrl}/v1/view`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Forwarded-For": a.ip },
    body: JSON.stringify({ portal: target.portal, post: target.post }),
  });
  return res.ok ? ((await res.json()) as Token) : null;
}

async function vote(
  target: Target, a: Actor, comment: string, dir: 1 | -1, token: Token | null, log: Action[],
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
      method: "POST", headers, body: JSON.stringify({ comment, dir }),
    });
    status = res.status;
    await res.body?.cancel();
  } catch {
    // status 0: portal nije odgovorio
  }
  log.push({
    t, role: a.role, side: a.side, level: a.level, actor: a.id, net: a.net,
    vid: token?.vid ?? null, target: comment, dir, status,
  });
}

async function fetchComments(target: Target): Promise<string[]> {
  const res = await fetch(`${target.portalUrl}/api/comments`);
  if (!res.ok) throw new Error(`portal ${target.portalUrl}: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }[]).map((c) => c.id);
}
