// Jedno izvođenje kampanje — zajedničko za komandnu liniju (`caci run`) i panel (`caci serve`):
// izbegavanje zauzetih prefiksa, tekstovi iz lokalnog LLM-a, izvođenje, dnevnik u runs/ i
// izveštaj iz baze kao tekst.

import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { Profile } from "./profile.js";
import {
  busyNets, format, formatComments, formatVerdicts, loadComments, loadRetro, loadVerdicts, loadVotes,
  summarize, summarizeComments, threads,
} from "./report.js";
import { run, type RunHooks, type RunLog } from "./run.js";
import { ollama } from "./texts.js";

const env = process.env;
export const RUNS = "runs";
/** Demo šalje događaje u pozadini (~1 s); malo rezerve pre čitanja baze. */
export const SETTLE_MS = 3_000;

export const portal = () => env.CACI_PORTAL ?? "demo.local";
export const postgres = () => env.CACI_POSTGRES_URL;

export async function campaign(profile: Profile, hooks: RunHooks & { texts?(): void } = {}): Promise<RunLog> {
  const url = postgres();
  // Prefiksi iz ranijih izvođenja (presude, naknadni shadow) bi se umešali u ovo.
  const avoid = url ? await busyNets(url, portal()) : new Set<string>();
  // Lokalni LLM: parafraze šablona (nivo 4) i komentari publike o člancima.
  let writer;
  if (profile.paraphrase || (profile.audience.comment_p ?? 0) > 0) {
    writer = ollama(env.CACI_OLLAMA_URL ?? "http://ollama:11434", env.CACI_LLM_MODEL ?? "gemma3:4b");
    await writer.check();
    hooks.texts?.();
  }
  const log = await run(
    profile,
    {
      portalUrl: (env.CACI_PORTAL_URL ?? "http://demo:3000").replace(/\/+$/, ""),
      apiUrl: (env.CACI_API_URL ?? "http://klaka-api:8081").replace(/\/+$/, ""),
      collectorUrl: (env.CACI_COLLECTOR_URL ?? "http://klaka-collector:8080").replace(/\/+$/, ""),
      portal: portal(),
    },
    avoid,
    writer,
    hooks,
  );
  await mkdir(RUNS, { recursive: true });
  await writeFile(`${RUNS}/${log.run}.json`, JSON.stringify(log, null, 1));
  return log;
}

/** Jedan red o izvođenju: koliko akcija i šta nije prošlo. */
export function summaryLine(log: RunLog): string {
  const failed = [...log.actions, ...log.comments].filter((a) => a.status !== 200).length;
  const extra = [
    failed && `${failed} bez odgovora 200`,
    log.skipped && `${log.skipped} glasova razvodnjivača preskočeno (još nema vidljivog komentara druga)`,
    log.paraphrase && `parafraza ${log.paraphrase.asked - log.paraphrase.fallback}/${log.paraphrase.asked}`,
  ].filter(Boolean);
  return `run ${log.run}: ${log.actions.length} glasova, ${log.comments.length} komentara` +
    (extra.length ? ` (${extra.join("; ")})` : "");
}

/** Dnevnik ranijeg izvođenja; oni iz ranijih verzija nemaju komentare. */
export async function loadRun(id: string): Promise<RunLog> {
  const old = JSON.parse(await readFile(`${RUNS}/${id}.json`, "utf8")) as Partial<RunLog> & Omit<RunLog, "comments" | "skipped">;
  return { ...old, comments: old.comments ?? [], skipped: old.skipped ?? 0 };
}

/** Izveštaj iz baze (docs/caci.md §7) kao tekst. */
export async function reportText(log: RunLog): Promise<string> {
  const url = postgres();
  if (!url) return "CACI_POSTGRES_URL nije postavljen — bez izveštaja";
  const retro = await loadRetro(url, log);
  const parts = [format(log, summarize(log, await loadVotes(url, log), retro))];
  const stored = await loadComments(url, log);
  const comments = formatComments(summarizeComments(log, stored, retro), threads(log, stored, retro));
  if (comments) parts.push("", comments);
  parts.push("", formatVerdicts(log, await loadVerdicts(url, log)));
  return parts.join("\n");
}
