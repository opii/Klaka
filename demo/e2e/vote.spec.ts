// Ceo lanac u pravom browseru: ts/ snippet → klaka-api (/v1/view) → demo backend → sdk/node.
// Svaki test koristi svoj komentar, da se brojači ne mešaju.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface Vote {
  comment: string;
  token: string;
  decision: "count" | "shadow";
}

async function score(request: APIRequestContext, id: string): Promise<number> {
  const comments = (await (await request.get("/api/comments")).json()) as { id: string; score: number }[];
  return comments.find((c) => c.id === id)!.score;
}

async function lastVote(request: APIRequestContext): Promise<Vote> {
  const votes = (await (await request.get("/admin/votes.json")).json()) as Vote[];
  return votes.at(-1)!;
}

/** Učitava članak i čeka da snippet dobije token od klaka-api. */
async function openArticle(page: Page): Promise<void> {
  await page.goto("/");
  const token = await page.evaluate(async () => (window as unknown as { klaka: { token(): Promise<string | null> } }).klaka.token());
  expect(token, "snippet treba da dobije token od klaka-api").toMatch(/^klaka1\./);
}

async function clickVote(page: Page, comment: string, dir: "1" | "-1"): Promise<void> {
  const box = page.locator(`[data-comment="${comment}"]`);
  const done = page.waitForResponse((r) => r.url().endsWith("/api/vote"));
  await box.locator(`button[data-dir="${dir}"]`).click();
  expect((await done).status()).toBe(200);
}

test("čitalac: glas posle čitanja ulazi u javni brojač", async ({ page, request }) => {
  const before = await score(request, "c1");
  await openArticle(page);
  await page.waitForTimeout(2_500); // duže od min_age (2 s)
  await clickVote(page, "c1", "1");

  expect(await lastVote(request)).toMatchObject({ comment: "c1", token: "valid", decision: "count" });
  expect(await score(request, "c1")).toBe(before + 1);
  await expect(page.locator('[data-comment="c1"] [data-score]')).toHaveText(String(before + 1));
});

test("prebrz glas posle učitavanja ide u shadow, a izgleda isto", async ({ page, request }) => {
  const before = await score(request, "c2");
  await openArticle(page);
  await clickVote(page, "c2", "1"); // odmah, token mlađi od 2 s

  expect(await lastVote(request)).toMatchObject({ comment: "c2", token: "too_young", decision: "shadow" });
  expect(await score(request, "c2"), "javni brojač se ne menja").toBe(before);
  // Glasač vidi svoj glas kao i svaki drugi (princip 3: napadač ne zna da je otkriven).
  await expect(page.locator('[data-comment="c2"] [data-score]')).toHaveText(String(before + 1));
});

test("bot bez tokena: isti odgovor, glas ne ulazi u brojač", async ({ request }) => {
  const before = await score(request, "c3");
  const res = await request.post("/api/vote", { data: { comment: "c3", dir: 1 } });

  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(await lastVote(request)).toMatchObject({ comment: "c3", token: "missing", decision: "shadow" });
  expect(await score(request, "c3")).toBe(before);
});

test("lažan token: isti odgovor, glas ne ulazi u brojač", async ({ request }) => {
  const before = await score(request, "c4");
  const fake = `klaka1.dev-1.${"A".repeat(40)}.${"A".repeat(86)}`;
  const res = await request.post("/api/vote", {
    data: { comment: "c4", dir: 1 },
    headers: { "X-Klaka-Token": fake },
  });

  expect(await res.json()).toEqual({ ok: true });
  expect(await lastVote(request)).toMatchObject({ comment: "c4", token: "bad_signature", decision: "shadow" });
  expect(await score(request, "c4")).toBe(before);
});

test("isti token za drugi post se ne računa", async ({ page, request }) => {
  await openArticle(page);
  const api = (await page.locator("script[data-api]").getAttribute("data-api"))!;
  const other = await request.post(`${api}/v1/view`, {
    data: JSON.stringify({ portal: "demo.local", post: "p-9999" }),
    headers: { "Content-Type": "text/plain" },
  });
  const { token } = (await other.json()) as { token: string };
  await page.waitForTimeout(2_500);

  await request.post("/api/vote", { data: { comment: "c1", dir: 1 }, headers: { "X-Klaka-Token": token } });
  expect(await lastVote(request)).toMatchObject({ comment: "c1", token: "wrong_post", decision: "shadow" });
});
