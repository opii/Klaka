// Pogledi „Poslušnik" i „Rendgen": tuđ shadow komentar se javno ne vidi, u Rendgenu se vidi sa
// razlogom (bez glasanja), a u pogledu poslušnika kao uračunat.

import { expect, test } from "@playwright/test";

const tag = () => Math.random().toString(36).slice(2, 8);

test("tuđ shadow komentar: javno ga nema, Rendgen ga pokazuje sa razlogom, poslušnik kao svoj", async ({ page, browser }) => {
  // Prebrz komentar (token mlađi od 2 s) ide u shadow: vidi ga samo autor.
  const text = `${tag()} ${tag()} prebrz komentar`;
  await page.goto("/p/p-1004");
  await page.evaluate(async () => (window as unknown as { klaka: { token(): Promise<string | null> } }).klaka.token());
  await page.getByLabel("Ime", { exact: true }).fill(`Brzi ${tag()}`);
  await page.getByLabel("Komentar", { exact: true }).fill(text);
  const done = page.waitForResponse((r) => r.url().endsWith("/api/comment"));
  await page.getByRole("button", { name: "Pošalji" }).click();
  await done;

  const other = await browser.newPage();
  await other.goto("/p/p-1004");
  await expect(other.getByText(text), "javno").toHaveCount(0);

  await other.getByRole("link", { name: "Rendgen" }).click();
  await expect(other.locator(".xsum")).toContainText("Rendgen:");
  const box = other.locator(".c").filter({ hasText: text });
  await expect(box).toHaveClass(/hidden-c/);
  await expect(box.locator(".b.shadow-b")).toContainText("u shadow-u (token: too_young)");
  await expect(box.locator("button[data-dir]"), "tuđ shadow komentar se ne glasa").toHaveCount(0);
  await expect(box, "bez seen: snippet ga ne broji").not.toHaveAttribute("data-klaka-comment", /.*/);

  await other.getByRole("link", { name: "Pogled poslušnika" }).click();
  await expect(other.locator(".banner")).toContainText("Ovako portal izgleda klaki");
  await expect(other.getByText(text)).toBeVisible();
  await other.close();
});
