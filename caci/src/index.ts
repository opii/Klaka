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

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parseProfile } from "./profile.js";
import { activeVerdictNets, format, formatVerdicts, loadVerdicts, loadVotes, summarize } from "./report.js";
import { run, type RunLog } from "./run.js";

const env = process.env;
const RUNS = "runs";
// Demo šalje događaje u pozadini (~1 s); malo rezerve pre čitanja baze.
const SETTLE_MS = 3_000;

async function main([cmd, arg]: string[]): Promise<void> {
  if (cmd === "run" && arg) {
    const profile = parseProfile(JSON.parse(await readFile(arg, "utf8")));
    const portal = env.CACI_PORTAL ?? "demo.local";
    // Prefiksi sa važećom presudom iz ranijih izvođenja bi novo izvođenje „nasledilo".
    const avoid = env.CACI_POSTGRES_URL ? await activeVerdictNets(env.CACI_POSTGRES_URL, portal) : new Set<string>();
    const log = await run(
      profile,
      {
        portalUrl: (env.CACI_PORTAL_URL ?? "http://demo:3000").replace(/\/+$/, ""),
        apiUrl: (env.CACI_API_URL ?? "http://klaka-api:8081").replace(/\/+$/, ""),
        collectorUrl: (env.CACI_COLLECTOR_URL ?? "http://klaka-collector:8080").replace(/\/+$/, ""),
        portal,
      },
      avoid,
    );
    await mkdir(RUNS, { recursive: true });
    await writeFile(`${RUNS}/${log.run}.json`, JSON.stringify(log, null, 1));
    const failed = log.actions.filter((a) => a.status !== 200).length;
    console.log(`run ${log.run}: ${log.actions.length} glasova${failed ? `, ${failed} bez odgovora 200` : ""}`);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return report(log);
  }
  if (cmd === "report" && arg) {
    return report(JSON.parse(await readFile(`${RUNS}/${arg}.json`, "utf8")) as RunLog);
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
  console.log(format(log, summarize(log, await loadVotes(url, log))));
  console.log("");
  console.log(formatVerdicts(log, await loadVerdicts(url, log)));
}

await main(process.argv.slice(2));
