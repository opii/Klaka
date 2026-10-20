// Poslušnik u pravom browseru (nivoi 2–4, docs/caci.md §3). Svaka akcija je novo učitavanje
// stranice: snippet uzme token i šalje `view`/`engage` kao kod svakog posetioca — ono što
// detektor prikaza-duhova više ne vidi kao duha. Komentar ide kroz formu, pa snippet šalje i
// `compose`: nivo 2 tekst nalepi, nivoi 3–4 ga kucaju.

import type { Browser, BrowserContext, Page } from "playwright-core";

import { sample, type Profile } from "./profile.js";
import { fellowsOf, type Actor, type Ctx, type PortalComment, type Task } from "./run.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Jedan zadatak (učitavanje, čekanje tokena, kucanje, slanje) traje desetak sekundi; zaglavljen
// zadatak obara izvođenje umesto da ga tiho zadrži.
const TASK_TIMEOUT_MS = 90_000;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

interface Klaka {
  token(): Promise<string | null>;
  headers(): Promise<Record<string, string>>;
  flush(): void;
}

interface How {
  click: boolean;
  careful: boolean;
}

export async function browserOperative(
  ctx: Ctx, a: Actor, plan: Task[], deadline: number, browser: Browser,
): Promise<void> {
  const p = ctx.profile;
  const careful = p.level >= 3;
  const how: How = { click: careful || p.browser?.click === true, careful };
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
    for (const task of plan) {
      if (Date.now() >= deadline) break;
      const page = await context.newPage();
      try {
        await within(TASK_TIMEOUT_MS, `${a.id}: ${task.kind}`, async () => {
          if (task.kind === "comment") {
            const id = await castComment(page, ctx, a, task, how);
            if (id && a.role === "diluter") fellowsOf(ctx, a).push({ id, post: task.post });
          } else {
            const goal = task.goal ?? fellowGoal(ctx, a);
            if (!goal || !(await castVote(page, ctx, a, goal, task.dir, how))) ctx.log.skipped++;
          }
        });
      } finally {
        await page.close({ runBeforeUnload: true }).catch(() => {});
      }
      await sleep(sample(p.delay_ms));
    }
  } finally {
    await context.close();
  }
}

async function within(ms: number, what: string, work: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nije završeno za ${ms / 1000} s`)), ms);
  });
  try {
    await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Komentar drugog razvodnjivača iste strane; da li je vidljiv, vidi se tek na stranici. */
function fellowGoal(ctx: Ctx, a: Actor): PortalComment | null {
  const own = new Set(ctx.log.comments.filter((c) => c.actor === a.id).map((c) => c.id));
  const candidates = fellowsOf(ctx, a).filter((c) => !own.has(c.id));
  return candidates.length ? pick(candidates) : null;
}

/** Učitava članak i čeka token; vraća ga (ili `null`). */
async function open(page: Page, p: Profile, ctx: Ctx, post: string): Promise<string | null> {
  await page.goto(`${ctx.target.portalUrl}/p/${post}`);
  const token = await page.evaluate(() => (window as unknown as { klaka: Klaka }).klaka.token());
  await sleep(p.token_wait_ms);
  return token;
}

/** Glas; `false` ako komentar nije na stranici (shadow komentar drugog poslušnika). */
async function castVote(page: Page, ctx: Ctx, a: Actor, goal: PortalComment, dir: 1 | -1, how: How): Promise<boolean> {
  const p = ctx.profile;
  const token = await open(page, p, ctx, goal.post);
  const box = page.locator(`[data-comment="${goal.id}"]`);
  if ((await box.count()) === 0) return false;
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
      { comment: goal.id, dir },
    );
  }
  // Zatvaranje taba šalje `engage` (pagehide); flush je isto, samo pouzdano u headless režimu.
  await page.evaluate(() => (window as unknown as { klaka: Klaka }).klaka.flush());
  ctx.log.actions.push({
    t, role: a.role, side: a.side, level: ctx.profile.level, actor: a.id, net: a.net,
    vid: token ? vidOf(token) : null, post: goal.post, target: goal.id, dir, status,
  });
  return true;
}

/** Komentar kroz formu; vraća ID koji je portal dao. */
async function castComment(
  page: Page, ctx: Ctx, a: Actor, task: Extract<Task, { kind: "comment" }>, how: How,
): Promise<string | null> {
  const p = ctx.profile;
  const token = await open(page, p, ctx, task.post);
  const form = page.locator("#komentar");
  const text = form.locator('textarea[name="text"]');
  if (how.careful) {
    await form.scrollIntoViewIfNeeded();
    await sleep(sample(p.dwell_ms ?? { median: 1500, sigma: 0.3 }));
  }
  await form.locator('input[name="author"]').fill(task.author);
  if (how.careful) {
    // Kuca kao čovek: stalan ritam po komentaru, bez lepljenja.
    await text.pressSequentially(task.text, { delay: Math.round(sample({ median: 110, sigma: 0.3 })) });
  } else {
    // „Desni klik → Nalepi": paste događaj sa tekstom, pa tekst u polje — bez ijednog tastera.
    await text.focus();
    await text.evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, task.text);
    await text.fill(task.text);
  }
  const before = new Set(await page.locator("[data-comment]").evaluateAll((els) => els.map((e) => e.id)));
  const t = Date.now();
  const res = page.waitForResponse((r) => r.url().endsWith("/api/comment"));
  const reload = page.waitForEvent("load").catch(() => {});
  await form.locator('button[type="submit"]').click();
  const status = (await res).status();
  // Telo odgovora se ne čita: stranica se odmah osvežava i browser ga odbacuje. ID se čita
  // sa osvežene stranice, kao što bi ga video i čovek — autor vidi svoj komentar i kad je shadow.
  let id: string | null = null;
  if (status === 200) {
    await reload;
    const mine = await page
      .locator("[data-comment]")
      .filter({ hasText: task.author })
      .filter({ hasText: task.text })
      .evaluateAll((els) => els.map((e) => e.id));
    id = mine.filter((x) => !before.has(x)).at(-1) ?? null;
  }
  ctx.log.comments.push({
    t, role: a.role, side: a.side, level: p.level, actor: a.id, net: a.net, vid: token ? vidOf(token) : null,
    post: task.post, id, author: task.author, text: task.text, status,
  });
  return id;
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
