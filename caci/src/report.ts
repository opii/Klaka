// Izveštaj (docs/caci.md §7): spaja dnevnik emulatora sa `vote` događajima iz baze — samo ono
// što bi postojalo i na pravom portalu, bez admin stranica demo-a.

import pg from "pg";

import type { Action, RunLog } from "./run.js";

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
      if (a.vid !== null && v.vid !== a.vid) continue;
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
    const group = a.role === "reader" ? "čitaoci" : `${a.side} ${a.role === "caci" ? "ćaci" : "pojačivači"} (nivo ${a.level})`;
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

export function format(log: RunLog, rows: Row[]): string {
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);
  const lines = [
    `run ${log.run} · profil ${log.profile.name} · ${((log.ended_ms - log.started_ms) / 1000).toFixed(0)} s`,
    "",
    "grupa                          glasova  u bazi  shadow  uračunato (pomeraj)  token",
  ];
  for (const r of rows) {
    const tokens = Object.entries(r.tokens).map(([k, n]) => `${k} ${n}`).join(", ") + (r.repeat ? `; ponovljen ${r.repeat}` : "");
    lines.push(
      `${r.group.padEnd(30)} ${String(r.votes).padStart(7)} ${String(r.matched).padStart(7)} ` +
        `${pct(r.shadow, r.matched).padStart(7)}  ${String(r.counted).padStart(19)}  ${tokens}`,
    );
  }
  lines.push(
    "",
    "Za poslušnike je shadow odziv, za čitaoce lažni pozitivi. Pomeraj je ono što je klaka",
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
       WHERE type = 'vote' AND portal = $1 AND post = $2 AND t BETWEEN $3 AND $4`,
      [log.portal, log.post, log.started_ms - MATCH_WINDOW_MS, log.ended_ms + MATCH_WINDOW_MS],
    );
    return res.rows.map((r) => ({ ...r, t: Number(r.t), dir: r.dir === -1 ? -1 : 1 }));
  } finally {
    await client.end();
  }
}
