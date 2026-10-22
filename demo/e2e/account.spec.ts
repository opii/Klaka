// Opcioni nalog: registracija, komentar pod nalogom (oznaka ✓, `cid` ide SDK-u), zaštita
// registrovanog pseudonima od anonimnih, odjava i prijava.

import { expect, test, type Page } from "@playwright/test";

interface StoredComment {
  id: string;
  author: string;
  account: number | null;
  decision: "count" | "shadow";
}

// Pseudonim i tekst su novi pri svakom pokretanju (nalog je trajan, a isti tekst sa iste mreže
// kroz postove bi bio šablon).
const tag = () => Math.random().toString(36).slice(2, 8);

async function comment(page: Page, post: string, text: string): Promise<void> {
  await page.goto(`/p/${post}`);
  await page.evaluate(async () => (window as unknown as { klaka: { token(): Promise<string | null> } }).klaka.token());
  await page.waitForTimeout(2_500); // duže od min_age (2 s)
  await page.getByLabel("Komentar", { exact: true }).pressSequentially(text, { delay: 5 });
  const done = page.waitForResponse((r) => r.url().endsWith("/api/comment"));
  await page.getByRole("button", { name: "Pošalji" }).click();
  await done;
}

test("nalog: registracija, komentar sa oznakom, odjava, zaštićen pseudonim, prijava", async ({ page, browser, request }) => {
  const name = `Tester ${tag()}`;
  const password = `lozinka-${tag()}`;

  await page.goto("/registracija?next=/p/p-1002");
  await page.getByLabel("Pseudonim").fill(name);
  await page.getByLabel("Lozinka").fill(password);
  await page.getByRole("button", { name: "Napravi nalog" }).click();
  await expect(page).toHaveURL(/\/p\/p-1002$/);
  await expect(page.locator("header .user")).toContainText(name);
  await expect(page.getByLabel("Ime", { exact: true }), "ime je pseudonim naloga").toHaveValue(name);

  const text = `${tag()} ${tag()} komentar sa naloga`;
  await comment(page, "p-1002", text);
  await page.waitForLoadState("load");
  const box = page.locator("[data-comment]").filter({ hasText: text });
  await expect(box.locator(".reg"), "oznaka registrovanog naloga").toBeVisible();
  const stored = ((await (await request.get("/admin/comments.json")).json()) as StoredComment[]).at(-1)!;
  expect(stored).toMatchObject({ author: name, decision: "count" });
  expect(stored.account).not.toBeNull();

  await page.getByRole("button", { name: "Odjava" }).click();
  await expect(page.locator("header .user")).toContainText("Prijava");

  // Anonimni posetilac ne može da komentariše pod registrovanim pseudonimom.
  const anon = await browser.newPage();
  await anon.goto("/p/p-1003");
  await anon.getByLabel("Ime", { exact: true }).fill(name.toUpperCase());
  await anon.getByLabel("Komentar", { exact: true }).fill(`${tag()} pokušaj pod tuđim imenom`);
  const refused = anon.waitForResponse((r) => r.url().endsWith("/api/comment"));
  await anon.getByRole("button", { name: "Pošalji" }).click();
  expect((await refused).status()).toBe(400);
  await expect(anon.locator("#komentar .err")).toContainText("registrovanom nalogu");
  await anon.close();

  await page.goto("/prijava");
  await page.getByLabel("Pseudonim").fill(name);
  await page.getByLabel("Lozinka").fill("pogresna-lozinka");
  await page.getByRole("button", { name: "Prijavi se" }).click();
  await expect(page.locator(".err")).toContainText("Pogrešan pseudonim ili lozinka");
  await page.getByLabel("Pseudonim").fill(name);
  await page.getByLabel("Lozinka").fill(password);
  await page.getByRole("button", { name: "Prijavi se" }).click();
  await expect(page.locator("header .user")).toContainText(name);
});
