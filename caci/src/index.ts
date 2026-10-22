// Emulator klake (docs/caci.md).
//
//   caci run <profil.json>     kampanja + publika, dnevnik u runs/<run>.json, pa izveštaj
//   caci report <run>          izveštaj za ranije izvođenje
//   caci serve                 HTTP servis za panel napada u adminu portala (serve.ts)
//
// Okruženje:
//   CACI_PORTAL_URL    demo portal            (http://demo:3000)
//   CACI_API_URL       klaka-api              (http://klaka-api:8081)
//   CACI_COLLECTOR_URL klaka-collector        (http://klaka-collector:8080)
//   CACI_PORTAL        portal                 (demo.local)
//   CACI_POSTGRES_URL  baza sa događajima; bez nje nema izveštaja
//   CACI_OLLAMA_URL, CACI_LLM_MODEL   parafraze (nivo 4) i komentari publike (http://ollama:11434, gemma3:4b)
//   CACI_PANEL_ADDR, CACI_PANEL_TOKEN, CACI_PANEL_ORIGIN   za `serve` (serve.ts)

import { readFile } from "node:fs/promises";

import { campaign, loadRun, reportText, SETTLE_MS, summaryLine } from "./campaign.js";
import { parseProfile } from "./profile.js";
import { serve } from "./serve.js";

async function main([cmd, arg]: string[]): Promise<void> {
  if (cmd === "run" && arg) {
    const profile = parseProfile(JSON.parse(await readFile(arg, "utf8")));
    const log = await campaign(profile, { texts: () => console.log("tekstovi pre početka (lokalni LLM)…") });
    console.log(summaryLine(log));
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    console.log(await reportText(log));
    return;
  }
  if (cmd === "report" && arg) {
    console.log(await reportText(await loadRun(arg)));
    return;
  }
  if (cmd === "serve") return serve();
  console.error("upotreba: caci run <profil.json> | caci report <run> | caci serve");
  process.exitCode = 2;
}

await main(process.argv.slice(2));
