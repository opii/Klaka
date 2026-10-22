// HTTP servis za panel napada (portal, /admin/napadi): izbor profila, pokretanje kampanje,
// praćenje uživo (SSE) i izveštaj. Jedno izvođenje u isto vreme. Emulator napada nije javan
// servis: sluša samo na 127.0.0.1 (`CACI_PANEL_ADDR`), traži token (`CACI_PANEL_TOKEN`, ≥ 16
// znakova) i prihvata samo origin portala (`CACI_PANEL_ORIGIN`). Panel ga zove iz browsera
// admina, pa portal u Docker mreži ne mora da dopire do hosta.
//
//   GET  /profiles          profili iz profiles/, sa opisom iz tabele u README.md
//   GET  /status            stanje tekućeg (ili poslednjeg) izvođenja
//   GET  /events?token=…    isto, kao SSE (EventSource ne šalje zaglavlja, pa token u adresi)
//   POST /runs {profile}    pokreće kampanju; 409 dok druga traje
//   GET  /runs              poslednja izvođenja (runs/)
//   GET  /runs/<id>/report  izveštaj iz baze, tekst

import { timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { campaign, loadRun, portal, postgres, reportText, RUNS, SETTLE_MS, summaryLine } from "./campaign.js";
import { parseProfile, type Profile } from "./profile.js";
import { groupOf, loadVerdicts } from "./report.js";
import type { RunLog } from "./run.js";

const PROFILES = "profiles";
const TOKEN_MIN = 16;
const TICK_MS = 1_000;
const VERDICTS_MS = 3_000;

type Phase = "priprema" | "tekstovi" | "kampanja" | "izveštaj" | "gotovo" | "greška";

interface Job {
  profile: string;
  phase: Phase;
  created_ms: number;
  log?: RunLog;
  verdicts: { net: string; detector: string; at_s: number; who: string }[];
  summary?: string;
  report?: string;
  error?: string;
}

let job: Job | null = null;
const listeners = new Set<ServerResponse>();

export async function serve(): Promise<void> {
  const env = process.env;
  const [host, port] = (env.CACI_PANEL_ADDR ?? "127.0.0.1:18095").split(":");
  const token = env.CACI_PANEL_TOKEN ?? "";
  const origin = env.CACI_PANEL_ORIGIN ?? "http://localhost:18082";
  if (token.length < TOKEN_MIN) throw new Error(`CACI_PANEL_TOKEN: bar ${TOKEN_MIN} znakova`);

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://caci");
    if (!authorized(req, url, token)) return json(res, 401, { error: "token" });
    handle(req, res, url).catch((e: Error) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: e.message });
    });
  });
  setInterval(broadcast, TICK_MS).unref();
  setInterval(() => void pollVerdicts().catch(() => {}), VERDICTS_MS).unref();
  await new Promise<void>((resolve) => server.listen(Number(port), host, resolve));
  console.log(`caci panel servis na ${host}:${port} (origin ${origin})`);
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /profiles") return json(res, 200, await profiles());
  if (route === "GET /status") return json(res, 200, snapshot());
  if (route === "GET /events") return events(req, res);
  if (route === "POST /runs") return start(req, res);
  if (route === "GET /runs") return json(res, 200, await recent());
  const report = url.pathname.match(/^\/runs\/([\w-]+)\/report$/);
  if (req.method === "GET" && report) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end(await reportText(await loadRun(report[1]!)));
  }
  json(res, 404, { error: "nema" });
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

interface ProfileInfo {
  name: string;
  level: number;
  roles: Profile["roles"];
  votes: number;
  comments: number;
  mirror: boolean;
  paraphrase: boolean;
  push: boolean;
  posts: string[];
  description: string;
}

/** Profili iz profiles/ sa opisom iz tabele „Profil | Šta pokazuje" u README.md. */
async function profiles(): Promise<ProfileInfo[]> {
  const notes = await descriptions();
  const out: ProfileInfo[] = [];
  for (const f of (await readdir(PROFILES)).filter((x) => x.endsWith(".json")).sort()) {
    const p = parseProfile(JSON.parse(await readFile(`${PROFILES}/${f}`, "utf8")));
    out.push({
      name: p.name, level: p.level, roles: p.roles, votes: p.votes, comments: p.comments ?? 0, mirror: p.mirror,
      paraphrase: p.paraphrase === true, push: !!p.audience.push,
      posts: [...new Set([...(p.targets.dilute ?? []), ...(p.audience.push?.posts ?? [])])],
      description: notes.get(p.name) ?? "",
    });
  }
  return out;
}

async function descriptions(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const readme = await readFile("README.md", "utf8").catch(() => "");
  for (const line of readme.split("\n")) {
    const m = line.match(/^\| (`[^|]+`) \| (.+) \|$/);
    if (!m) continue;
    const text = m[2]!.replace(/\*\*|`/g, "");
    for (const name of m[1]!.matchAll(/`([\w-]+)\.json`/g)) out.set(name[1]!, text);
  }
  return out;
}

async function start(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (job && !["gotovo", "greška"].includes(job.phase)) return json(res, 409, { error: "izvođenje u toku", ...snapshot() });
  let body = "";
  for await (const chunk of req) body += chunk;
  const name = (JSON.parse(body || "{}") as { profile?: string }).profile ?? "";
  if (!/^[\w-]+$/.test(name)) return json(res, 400, { error: "profil" });
  let profile: Profile;
  try {
    profile = parseProfile(JSON.parse(await readFile(`${PROFILES}/${name}.json`, "utf8")));
  } catch {
    return json(res, 404, { error: "nema profila" });
  }
  const current: Job = { profile: name, phase: "priprema", created_ms: Date.now(), verdicts: [] };
  job = current;
  void campaign(profile, {
    texts: () => void (current.phase = "tekstovi"),
    created: (log) => void (current.log = log),
    started: () => void (current.phase = "kampanja"),
  })
    .then(async (log) => {
      current.log = log;
      current.summary = summaryLine(log);
      current.phase = "izveštaj";
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      await pollVerdicts();
      current.report = await reportText(log);
      current.phase = "gotovo";
    })
    .catch((e: Error) => {
      current.error = e.message;
      current.phase = "greška";
    })
    .finally(broadcast);
  json(res, 202, snapshot());
}

function snapshot(): object {
  if (!job) return { phase: null };
  const log = job.log;
  const started = log?.started_ms || 0;
  return {
    profile: job.profile,
    phase: job.phase,
    run: log?.run ?? null,
    elapsed_s: Math.round((Date.now() - (started || job.created_ms)) / 1000),
    votes: log?.actions.length ?? 0,
    comments: log?.comments.length ?? 0,
    skipped: log?.skipped ?? 0,
    verdicts: job.verdicts,
    summary: job.summary ?? null,
    report: job.report ?? null,
    error: job.error ?? null,
  };
}

function events(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  listeners.add(res);
  req.on("close", () => listeners.delete(res));
}

let last = "";
function broadcast(): void {
  const data = JSON.stringify(snapshot());
  // Posle kraja izvođenja stanje se ne menja: šalje se samo kad ima promene (i vreme teče).
  if (data === last && job && ["gotovo", "greška"].includes(job.phase)) return;
  last = data;
  for (const res of listeners) res.write(`data: ${data}\n\n`);
}

/** Presude engine-a za prefikse ovog izvođenja, čim nastanu: reakcija Klake uživo. */
async function pollVerdicts(): Promise<void> {
  const url = postgres();
  const current = job;
  if (!url || !current?.log?.started_ms || !["kampanja", "izveštaj"].includes(current.phase)) return;
  const log = current.log;
  const groups = new Map<string, Set<string>>();
  for (const a of [...log.actions, ...log.comments]) {
    const g = groups.get(a.net) ?? new Set<string>();
    g.add(groupOf(a));
    groups.set(a.net, g);
  }
  current.verdicts = (await loadVerdicts(url, log))
    .filter((v) => groups.has(v.net) && v.created_ms >= log.started_ms)
    .sort((a, b) => a.created_ms - b.created_ms)
    .map((v) => ({
      net: v.net, detector: v.detector, at_s: Math.round((v.created_ms - log.started_ms) / 1000),
      who: [...groups.get(v.net)!].join(", "),
    }));
}

/** Poslednja izvođenja iz runs/ (bez čitanja celih dnevnika u memoriju više puta). */
async function recent(): Promise<object[]> {
  const files = (await readdir(RUNS).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse();
  const out: object[] = [];
  for (const f of files.slice(0, 20)) {
    try {
      const log = await loadRun(f.replace(/\.json$/, ""));
      out.push({
        run: log.run, profile: log.profile.name, started_ms: log.started_ms,
        seconds: Math.round((log.ended_ms - log.started_ms) / 1000),
        votes: log.actions.length, comments: log.comments.length, portal: log.portal ?? portal(),
      });
    } catch {
      // nedovršen ili stari dnevnik
    }
  }
  return out;
}
