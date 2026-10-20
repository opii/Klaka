// Izveštaj (docs/caci.md §7): spaja dnevnik emulatora sa `vote` događajima iz baze — samo ono
// što bi postojalo i na pravom portalu, bez admin stranica demo-a.

import pg from "pg";

import type { Action, CommentAction, RunLog } from "./run.js";

export interface StoredVote {
  t: number;
  vid: string | null;
  net: string;
  target: string;
  dir: 1 | -1;
  token: string;
  decision: "count" | "shadow" | "challenge";
  repeat: boolean | null;
}

export const MATCH_WINDOW_MS = 2_000;

/** Svakoj akciji najbliži neiskorišćen događaj sa istim ciljem, smerom, prefiksom (i `vid`-om). */
export function match(actions: Action[], votes: StoredVote[]): Map<Action, StoredVote> {
  const used = new Set<StoredVote>();
  const out = new Map<Action, StoredVote>();
  for (const a of [...actions].sort((x, y) => x.t - y.t)) {
    let best: StoredVote | null = null;
    for (const v of votes) {
      if (used.has(v) || v.target !== a.target || v.dir !== a.dir || v.net !== a.net) continue;
      // Bez vid-a u događaju: token nije prošao proveru potpisa — spaja se po ostalom.
      if (a.vid !== null && v.vid !== null && v.vid !== a.vid) continue;
      const d = Math.abs(v.t - a.t);
      if (d <= MATCH_WINDOW_MS && (!best || d < Math.abs(best.t - a.t))) best = v;
    }
    if (best) {
      used.add(best);
      out.set(a, best);
    }
  }
  return out;
}

export interface Row {
  group: string;
  votes: number;
  matched: number;
  shadow: number;
  /** Pomeraj javnog zbira: zbir smerova glasova koji su uračunati. */
  counted: number;
  tokens: Record<string, number>;
  /** Glasovi u shadow zbog pravila jedan glas po (vid, cilj), sdk.md §2a. */
  repeat: number;
}

export function summarize(log: RunLog, votes: StoredVote[]): Row[] {
  const matched = match(log.actions, votes);
  const rows = new Map<string, Row>();
  for (const a of log.actions) {
    const group = groupOf(a);
    const r = rows.get(group) ?? { group, votes: 0, matched: 0, shadow: 0, counted: 0, tokens: {}, repeat: 0 };
    r.votes++;
    const v = matched.get(a);
    if (v) {
      r.matched++;
      if (v.decision === "count") r.counted += v.dir;
      else r.shadow++;
      r.tokens[v.token] = (r.tokens[v.token] ?? 0) + 1;
      if (v.repeat) r.repeat++;
    }
    rows.set(group, r);
  }
  return [...rows.values()].sort((x, y) => x.group.localeCompare(y.group));
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

export function format(log: RunLog, rows: Row[]): string {
  const lines = [
    `run ${log.run} · profil ${log.profile.name} · ${((log.ended_ms - log.started_ms) / 1000).toFixed(0)} s`,
  ];
  if (rows.length === 0) return lines.join("\n");
  lines.push(
    "",
    "grupa                          glasova  u bazi  shadow  uračunato (pomeraj)  token",
  );
  for (const r of rows) {
    const tokens = Object.entries(r.tokens).map(([k, n]) => `${k} ${n}`).join(", ") + (r.repeat ? `; ponovljen ${r.repeat}` : "");
    lines.push(
      `${r.group.padEnd(30)} ${String(r.votes).padStart(7)} ${String(r.matched).padStart(7)} ` +
        `${pct(r.shadow, r.matched).padStart(7)}  ${String(r.counted).padStart(19)}  ${tokens}`,
    );
  }
  lines.push(
    "",
    "Za poslušnike je shadow odziv, za čitaoce (i CGNAT) lažni pozitivi. Pomeraj je ono što je klaka",
    "zaista kupila; strane A i B (ogledalo) treba da imaju isti shadow.",
  );
  return lines.join("\n");
}

export async function loadVotes(url: string, log: RunLog): Promise<StoredVote[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{
      t: string; vid: string | null; net: string; target: string; dir: number; token: string; decision: StoredVote["decision"]; repeat: boolean | null;
    }>(
      `SELECT t, vid, net, data->>'target' AS target, (data->>'dir')::int AS dir,
              data->>'token' AS token, data->>'decision' AS decision,
              (data->>'repeat')::boolean AS repeat
       FROM events
       WHERE type = 'vote' AND portal = $1 AND t BETWEEN $2 AND $3`,
      [log.portal, log.started_ms - MATCH_WINDOW_MS, log.ended_ms + MATCH_WINDOW_MS],
    );
    return res.rows.map((r) => ({ ...r, t: Number(r.t), dir: r.dir === -1 ? -1 : 1 }));
  } finally {
    await client.end();
  }
}

const ROLE_NAMES = { amplifier: "pojačivači", caci: "ćaci", diluter: "razvodnjivači" } as const;

export function groupOf(a: Action | CommentAction): string {
  if (a.role === "reader") return "čitaoci";
  if (a.role === "cgnat") return "čitaoci iza CGNAT-a";
  return `${a.side} ${ROLE_NAMES[a.role]} (nivo ${a.level})`;
}

export interface StoredComment {
  id: string;
  post: string;
  token: string;
  decision: "count" | "shadow" | "challenge";
}

export interface CommentRow {
  group: string;
  written: number;
  matched: number;
  shadow: number;
  tokens: Record<string, number>;
}

/** Komentari po grupi; spajanje po ID-ju koji je portal dao (isti u `comment` događaju). */
export function summarizeComments(log: RunLog, stored: StoredComment[]): CommentRow[] {
  const byId = new Map(stored.map((c) => [c.id, c]));
  const rows = new Map<string, CommentRow>();
  for (const a of log.comments) {
    const group = groupOf(a);
    const r = rows.get(group) ?? { group, written: 0, matched: 0, shadow: 0, tokens: {} };
    r.written++;
    const c = a.id ? byId.get(a.id) : undefined;
    if (c) {
      r.matched++;
      if (c.decision !== "count") r.shadow++;
      r.tokens[c.token] = (r.tokens[c.token] ?? 0) + 1;
    }
    rows.set(group, r);
  }
  return [...rows.values()].sort((x, y) => x.group.localeCompare(y.group));
}

export interface Thread {
  post: string;
  /** Javni (`count`) komentari na članku tokom izvođenja. */
  public: number;
  /** Od toga komentara klake. */
  klaka: number;
  /** Komentari klake na članku koji su završili u shadow. */
  shadowed: number;
}

/**
 * Udeo klake u javnim komentarima članaka na kojima je pisala — merilo za razvodnjivače, kao
 * pomeraj javnog zbira za glasove: koliko je javne rasprave klaka zauzela.
 */
export function threads(log: RunLog, stored: StoredComment[]): Thread[] {
  const klaka = new Set(log.comments.filter((c) => c.side !== null && c.id).map((c) => c.id!));
  const posts = [...new Set(log.comments.filter((c) => c.side !== null).map((c) => c.post))].sort();
  return posts.map((post) => {
    const here = stored.filter((c) => c.post === post);
    const pub = here.filter((c) => c.decision === "count");
    return {
      post,
      public: pub.length,
      klaka: pub.filter((c) => klaka.has(c.id)).length,
      shadowed: here.filter((c) => c.decision !== "count" && klaka.has(c.id)).length,
    };
  });
}

export function formatComments(rows: CommentRow[], list: Thread[]): string {
  if (rows.length === 0) return "";
  const lines = ["grupa                          komentara  u bazi  shadow  javno  token"];
  for (const r of rows) {
    const tokens = Object.entries(r.tokens).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(
      `${r.group.padEnd(30)} ${String(r.written).padStart(9)} ${String(r.matched).padStart(7)} ` +
        `${pct(r.shadow, r.matched).padStart(7)} ${String(r.matched - r.shadow).padStart(6)}  ${tokens}`,
    );
  }
  if (list.length) {
    lines.push("", "Udeo klake u javnim komentarima članka, tokom izvođenja (razvodnjivači: što manje, to bolje):");
    for (const t of list) {
      lines.push(`  ${t.post}: ${t.klaka} od ${t.public} javnih (${pct(t.klaka, t.public)}); u shadow još ${t.shadowed}`);
    }
  }
  return lines.join("\n");
}

export async function loadComments(url: string, log: RunLog): Promise<StoredComment[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<StoredComment>(
      `SELECT data->>'comment' AS id, post, data->>'token' AS token, data->>'decision' AS decision
       FROM events
       WHERE type = 'comment' AND source = 'server' AND portal = $1 AND t BETWEEN $2 AND $3`,
      [log.portal, log.started_ms - MATCH_WINDOW_MS, log.ended_ms + MATCH_WINDOW_MS],
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

export interface StoredVerdict {
  net: string;
  rev: number;
  created_ms: number;
  /** Detektori čiji su nalazi u presudi, npr. `focused-votes+shared-templates`. */
  detector: string;
}

/** Presude engine-a za prefikse ovog izvođenja: koga su pogodile i kada. */
export function formatVerdicts(log: RunLog, verdicts: StoredVerdict[]): string {
  const byNet = new Map<string, Map<string, number>>();
  const count = (a: Action | CommentAction, what: string) => {
    const g = byNet.get(a.net) ?? new Map<string, number>();
    const key = `${groupOf(a)}: ${what}`;
    g.set(key, (g.get(key) ?? 0) + 1);
    byNet.set(a.net, g);
  };
  for (const a of log.actions) count(a, "glasova");
  for (const c of log.comments) count(c, "komentara");
  const ours = verdicts.filter((v) => byNet.has(v.net));
  if (ours.length === 0) return "presude engine-a: nijedna";
  const lines = [`presude engine-a (shadow po prefiksu): ${ours.length}`];
  for (const v of ours.sort((x, y) => x.created_ms - y.created_ms)) {
    const who = [...byNet.get(v.net)!].map(([g, n]) => g.replace(/: (\S+)$/, `: ${n} $1`)).join(", ");
    const dt = Math.round((v.created_ms - log.started_ms) / 1000);
    // Negativno: presuda iz ranijeg izvođenja koja još važi za prefiks ovog.
    const when = dt >= 0 ? `+${dt} s` : `${dt} s (pre početka!)`;
    lines.push(`  ${when}  ${v.net}  [${v.detector}]  ←  ${who}`);
  }
  return lines.join("\n");
}

export async function loadVerdicts(url: string, log: RunLog): Promise<StoredVerdict[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ key: string; rev: number; created_ms: string; detector: string }>(
      `SELECT key, rev, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms, detector
       FROM verdicts
       WHERE portal = $1 AND key_kind = 'net' AND until_ms >= $2`,
      [log.portal, log.started_ms],
    );
    return res.rows.map((r) => ({ net: r.key, rev: r.rev, created_ms: Number(r.created_ms), detector: r.detector }));
  } catch {
    return []; // engine još nije napravio tabelu
  } finally {
    await client.end();
  }
}

/** Prefiksi sa presudom koja još važi — emulator ih izbegava. */
export async function activeVerdictNets(url: string, portal: string): Promise<Set<string>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ key: string }>(
      `SELECT DISTINCT key FROM verdicts WHERE portal = $1 AND key_kind = 'net' AND until_ms > $2`,
      [portal, Date.now()],
    );
    return new Set(res.rows.map((r) => r.key));
  } catch {
    return new Set();
  } finally {
    await client.end();
  }
}
