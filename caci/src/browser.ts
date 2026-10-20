// Poslušnik u pravom browseru (nivoi 2–3, docs/caci.md §3). Svaki glas je novo učitavanje
// stranice: snippet uzme token i šalje `view`/`engage` kao kod svakog posetioca — ono što
// detektor prikaza-duhova više ne vidi kao duha.

import type { Browser, BrowserContext, Page } from "playwright-core";

import { sample, type Profile } from "./profile.js";
import type { Action, Actor, Target } from "./run.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Klaka {
  token(): Promise<string | null>;
  headers(): Promise<Record<string, string>>;
  flush(): void;
}

export async function browserOperative(
  p: Profile, target: Target, a: Actor, goals: string[], dir: 1 | -1, log: Action[], browser: Browser,
): Promise<void> {
  const careful = p.level === 3;
  const click = careful || p.browser?.click === true;
  const hide = careful || p.browser?.hide_webdriver === true;
  const context = await browser.newContext({
    viewport: { width: 1300, height: 700 },
    // Lenj poslušnik ostavlja „HeadlessChrome" u UA; pažljiv ga menja.
    ...(hide ? { userAgent: a.ua } : {}),
  });
  await withAddress(context, a.ip);
  if (hide) {
    await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
  }
  try {
    for (let n = 0; n < p.votes; n++) {
      const page = await context.newPage();
      try {
        await castVote(page, p, target, a, goals[n % goals.length]!, dir, log, { click, careful });
      } finally {
        await page.close({ runBeforeUnload: true }).catch(() => {});
      }
      await sleep(sample(p.delay_ms));
    }
  } finally {
    await context.close();
  }
}

async function castVote(
  page: Page, p: Profile, target: Target, a: Actor, comment: string, dir: 1 | -1, log: Action[],
  how: { click: boolean; careful: boolean },
): Promise<void> {
  await page.goto(target.portalUrl + "/");
  const token = await page.evaluate(() => (window as unknown as { klaka: Klaka }).klaka.token());
  await sleep(p.token_wait_ms);

  const box = page.locator(`[data-comment="${comment}"]`);
  if (how.careful) {
    await box.scrollIntoViewIfNeeded();
    await sleep(sample(p.dwell_ms ?? { median: 1500, sigma: 0.3 }));
  }
  const t = Date.now();
  let status = 0;
  if (how.click) {
    const res = page.waitForResponse((r) => r.url().endsWith("/api/vote"));
    await box.locator(`button[data-dir="${dir}"]`).click();
    status = (await res).status();
  } else {
    // Bez klika: glas iz konzole, istim putem kao stranica (zaglavlje sa tokenom).
    status = await page.evaluate(
      async ({ comment, dir }) => {
        const k = (window as unknown as { klaka: Klaka }).klaka;
        const headers = { "Content-Type": "application/json", ...(await k.headers()) };
        const res = await fetch("/api/vote", { method: "POST", headers, body: JSON.stringify({ comment, dir }) });
        return res.status;
      },
      { comment, dir },
    );
  }
  // Zatvaranje taba šalje `engage` (pagehide); flush je isto, samo pouzdano u headless režimu.
  await page.evaluate(() => (window as unknown as { klaka: Klaka }).klaka.flush());
  log.push({
    t, role: a.role, side: a.side, level: p.level, actor: a.id, net: a.net,
    vid: token ? vidOf(token) : null, target: comment, dir, status,
  });
}

/**
 * Adresa poslušnika na svakom zahtevu konteksta (stranica, klaka-api, collector, beacon).
 * Preko `route`, ne `extraHTTPHeaders`: dodato zaglavlje ne sme da pretvori jednostavan
 * CORS zahtev u preflight.
 */
async function withAddress(context: BrowserContext, ip: string): Promise<void> {
  await context.route("**/*", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }),
  );
}

/** `vid` iz payload-a tokena (token.md §2) — samo za dnevnik emulatora. */
function vidOf(token: string): string | null {
  try {
    return (JSON.parse(Buffer.from(token.split(".")[2]!, "base64url").toString()) as { vid: string }).vid;
  } catch {
    return null;
  }
}
