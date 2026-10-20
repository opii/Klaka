// Komentari u pravom browseru: forma → sdk/node onComment, `compose` iz snippeta, shadow
// komentar vidi samo autor (princip 3: odgovor i prikaz su isti kao za count).

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface StoredComment {
  id: string;
  post: string;
  author: string;
  token: string | null;
  decision: "count" | "shadow";
}

interface Ev {
  type: string;
  [k: string]: unknown;
}

async function lastComment(request: APIRequestContext): Promise<StoredComment> {
  return ((await (await request.get("/admin/comments.json")).json()) as StoredComment[]).at(-1)!;
}

async function openArticle(page: Page, post: string): Promise<void> {
  await page.goto(`/p/${post}`);
  await page.evaluate(async () => (window as unknown as { klaka: { token(): Promise<string | null> } }).klaka.token());
}

/** Šalje formu i čeka osvežavanje stranice posle odgovora. */
async function submit(page: Page): Promise<void> {
  const done = page.waitForResponse((r) => r.url().endsWith("/api/comment"));
  const reload = page.waitForEvent("load");
  await page.getByRole("button", { name: "Pošalji" }).click();
  expect((await done).status()).toBe(200);
  await reload;
}

test("komentar posle čitanja: vide ga svi, compose stiže collector-u", async ({ page, browser, request }) => {
  const events: Ev[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.method() === "POST") {
      events.push(...(JSON.parse(r.postData() ?? "{}") as { events: Ev[] }).events);
    }
  });
  const text = `Biblioteka nedeljom je dobra vest ${Date.now()}`;
  await openArticle(page, "p-1002");
  await page.waitForTimeout(2_500); // duže od min_age (2 s)
  await page.getByLabel("Ime", { exact: true }).fill("Tester");
  await page.getByLabel("Komentar", { exact: true }).pressSequentially(text, { delay: 5 });
  await submit(page);

  expect(await lastComment(request)).toMatchObject({ post: "p-1002", author: "Tester", token: "valid", decision: "count" });
  await expect(page.getByText(text)).toBeVisible();
  const compose = events.find((e) => e.type === "compose");
  expect(compose).toMatchObject({ post: "p-1002", keys: "11-50", pasted: false, length: "1-50" });

  const other = await browser.newPage();
  await other.goto("/p/p-1002");
  await expect(other.getByText(text), "drugi posetilac vidi uračunat komentar").toBeVisible();
  await other.close();
});

test("prebrz komentar ide u shadow: autor ga vidi, ostali ne", async ({ page, browser, request }) => {
  const text = `Prebrz komentar ${Date.now()}`;
  await openArticle(page, "p-1003");
  await page.getByLabel("Ime", { exact: true }).fill("Brzi");
  await page.getByLabel("Komentar", { exact: true }).fill(text);
  await submit(page); // odmah, token mlađi od 2 s

  const stored = await lastComment(request);
  expect(stored).toMatchObject({ post: "p-1003", token: "too_young", decision: "shadow" });
  await expect(page.getByText(text), "autor vidi svoj komentar kao i svaki drugi").toBeVisible();

  const other = await browser.newPage();
  await other.goto("/p/p-1003");
  await expect(other.locator(`[data-comment="${stored.id}"]`)).toHaveCount(0);
  await other.close();
  const pub = (await (await request.get("/api/comments?post=p-1003")).json()) as { id: string }[];
  expect(pub.map((c) => c.id)).not.toContain(stored.id);
  // Glas na tuđ shadow komentar: kao da komentar ne postoji.
  expect((await request.post("/api/vote", { data: { comment: stored.id, dir: 1 } })).status()).toBe(400);
});
