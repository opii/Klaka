// Panel napada (/admin/napadi): prijava admina, profili iz caci servisa, tok uživo. Kampanju ne
// pokreće (pomešala bi brojače ostalih testova). Preskače se bez admin lozinke ili caci-panel-a.

import { expect, test } from "@playwright/test";

const password = process.env.PORTAL_ADMIN_PASSWORD ?? "";

test("panel napada: bez prijave 401, sa prijavom profili i stanje caci servisa", async ({ browser, request }) => {
  test.skip(!password, "PORTAL_ADMIN_PASSWORD nije postavljen");
  const caci = await fetch("http://localhost:18095/status").then((r) => r.status, () => 0);
  test.skip(caci !== 401, "caci-panel ne radi (docker compose --profile napadi up -d caci-panel)");

  expect((await request.get("/admin/napadi")).status()).toBe(401);

  const context = await browser.newContext({ httpCredentials: { username: "admin", password } });
  const page = await context.newPage();
  await page.goto("/admin/napadi");
  await expect(page.locator("select option[value='rasuta-3']")).toHaveCount(1);
  await page.locator("select").selectOption("rasuta-3");
  await expect(page.locator("[data-desc]")).toContainText("rasuta po prefiksima");
  await expect(page.locator("[data-state]")).not.toContainText("povezivanje");
  await context.close();
});
