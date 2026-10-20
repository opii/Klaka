// Emulator klake (docs/caci.md).
//
//   caci run <profil.json>     kampanja + publika, dnevnik u runs/<run>.json, pa izveštaj
//   caci report <run>          izveštaj za ranije izvođenje
//
// Okruženje:
//   CACI_PORTAL_URL    demo portal            (http://demo:3000)
//   CACI_API_URL       klaka-api              (http://klaka-api:8081)
//   CACI_COLLECTOR_URL klaka-collector        (http://klaka-collector:8080)
//   CACI_PORTAL        portal                 (demo.local)
//   CACI_POSTGRES_URL  baza sa događajima; bez nje nema izveštaja
//   CACI_OLLAMA_URL, CACI_LLM_MODEL   parafraze (nivo 4) i komentari publike (http://ollama:11434, gemma3:4b)

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parseProfile } from "./profile.js";
import {
  busyNets, format, formatComments, formatVerdicts, loadComments, loadRetro, loadVerdicts, loadVotes,
  summarize, summarizeComments, threads,
} from "./report.js";
import { run, type RunLog } from "./run.js";
import { ollama } from "./texts.js";

const env = process.env;
const RUNS = "runs";
// Demo šalje događaje u pozadini (~1 s); malo rezerve pre čitanja baze.
const SETTLE_MS = 3_000;

async function main([cmd, arg]: string[]): Promise<void> {
  if (cmd === "run" && arg) {
    const profile = parseProfile(JSON.parse(await readFile(arg, "utf8")));
    const portal = env.CACI_PORTAL ?? "demo.local";
    // Prefiksi iz ranijih izvođenja (presude, naknadni shadow) bi se umešali u ovo.
    const avoid = env.CACI_POSTGRES_URL ? await busyNets(env.CACI_POSTGRES_URL, portal) : new Set<string>();
    // Lokalni LLM: parafraze šablona (nivo 4) i komentari publike o člancima.
    let writer;
    if (profile.paraphrase || (profile.audience.comment_p ?? 0) > 0) {
      writer = ollama(env.CACI_OLLAMA_URL ?? "http://ollama:11434", env.CACI_LLM_MODEL ?? "gemma3:4b");
      await writer.check();
      console.log("tekstovi pre početka (lokalni LLM)…");
    }
    const log = await run(
      profile,
      {
        portalUrl: (env.CACI_PORTAL_URL ?? "http://demo:3000").replace(/\/+$/, ""),
        apiUrl: (env.CACI_API_URL ?? "http://klaka-api:8081").replace(/\/+$/, ""),
        collectorUrl: (env.CACI_COLLECTOR_URL ?? "http://klaka-collector:8080").replace(/\/+$/, ""),
        portal,
      },
      avoid,
      writer,
    );
    await mkdir(RUNS, { recursive: true });
    await writeFile(`${RUNS}/${log.run}.json`, JSON.stringify(log, null, 1));
    const failed = [...log.actions, ...log.comments].filter((a) => a.status !== 200).length;
    const extra = [
      failed && `${failed} bez odgovora 200`,
      log.skipped && `${log.skipped} glasova razvodnjivača preskočeno (još nema vidljivog komentara druga)`,
      log.paraphrase && `parafraza ${log.paraphrase.asked - log.paraphrase.fallback}/${log.paraphrase.asked}`,
    ].filter(Boolean);
    console.log(
      `run ${log.run}: ${log.actions.length} glasova, ${log.comments.length} komentara` +
        (extra.length ? ` (${extra.join("; ")})` : ""),
    );
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return report(log);
  }
  if (cmd === "report" && arg) {
    // Dnevnici iz ranijih verzija nemaju komentare.
    const old = JSON.parse(await readFile(`${RUNS}/${arg}.json`, "utf8")) as Partial<RunLog> & Omit<RunLog, "comments" | "skipped">;
    return report({ ...old, comments: old.comments ?? [], skipped: old.skipped ?? 0 });
  }
  console.error("upotreba: caci run <profil.json> | caci report <run>");
  process.exitCode = 2;
}

async function report(log: RunLog): Promise<void> {
  const url = env.CACI_POSTGRES_URL;
  if (!url) {
    console.log("CACI_POSTGRES_URL nije postavljen — bez izveštaja");
    return;
  }
  const retro = await loadRetro(url, log);
  console.log(format(log, summarize(log, await loadVotes(url, log), retro)));
  const stored = await loadComments(url, log);
  const comments = formatComments(summarizeComments(log, stored, retro), threads(log, stored, retro));
  if (comments) console.log(`\n${comments}`);
  console.log("");
  console.log(formatVerdicts(log, await loadVerdicts(url, log)));
}

await main(process.argv.slice(2));
