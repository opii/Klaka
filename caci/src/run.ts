// Izvođenje kampanje: poslušnici obe strane ogledala + legitimna publika, istovremeno.
// Svaka akcija se beleži (ground truth, docs/caci.md §7); ishod se čita tek iz baze (report.ts).

import { randomBytes } from "node:crypto";

import { Prefixes } from "./net.js";
import { sample, type Level, type Profile, type Role, type Side } from "./profile.js";

export interface Target {
  portalUrl: string;
  apiUrl: string;
  portal: string;
  post: string;
}

export interface Action {
  t: number;
  role: Role | "reader";
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

export async function run(profile: Profile, target: Target): Promise<RunLog> {
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const actions: Action[] = [];
  const nets = new Prefixes();
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

  for (let i = 0; i < profile.audience.readers; i++) {
    const prefix = nets.take();
    const reader = {
      id: `reader-${i}`, role: "reader" as const, side: null, level: null, ip: nets.host(prefix),
      net: `${prefix}.0/24`, ua: pick(UA_READERS),
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
  role: Role | "reader";
  side: Side | null;
  level: Level | null;
  ip: string;
  net: string;
  ua: string;
}

/** Poslušnik: nivo 0 bez tokena, nivo 1 sa jednim tokenom za ceo zadatak. */
async function operative(
  p: Profile, target: Target, a: Actor, goals: string[], dir: 1 | -1, log: Action[],
): Promise<void> {
  let token: { token: string; vid: string } | null = null;
  if (p.level === 1) {
    token = await view(target);
    await sleep(p.token_wait_ms);
  }
  for (let n = 0; n < p.votes; n++) {
    await vote(target, a, goals[n % goals.length]!, dir, token, log);
    await sleep(sample(p.delay_ms));
  }
}

/** Čitalac: uzima token kao snippet, čita, ponekad glasa. */
async function read(p: Profile, target: Target, a: Actor, comments: string[], log: Action[]): Promise<void> {
  const token = await view(target);
  await sleep(sample(p.audience.read_ms));
  if (Math.random() < p.audience.vote_p) {
    await vote(target, a, pick(comments), Math.random() < 0.7 ? 1 : -1, token, log);
  }
}

async function view(target: Target): Promise<{ token: string; vid: string } | null> {
  const res = await fetch(`${target.apiUrl}/v1/view`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ portal: target.portal, post: target.post }),
  });
  return res.ok ? ((await res.json()) as { token: string; vid: string }) : null;
}

async function vote(
  target: Target, a: Actor, comment: string, dir: 1 | -1, token: { token: string; vid: string } | null, log: Action[],
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
