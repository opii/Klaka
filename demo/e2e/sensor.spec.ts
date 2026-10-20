// Senzor u pravom browseru: ts/ snippet šalje `view` i `engage` collector-u (core/spec/events.md §2).

import { expect, test } from "@playwright/test";

interface Ev {
  type: string;
  vid: string;
  [k: string]: unknown;
}

test("view odmah posle tokena, engage sa skrolovanjem i viđenim komentarima", async ({ page }) => {
  const events: Ev[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.method() === "POST") {
      events.push(...(JSON.parse(r.postData() ?? "{}") as { events: Ev[] }).events);
    }
  });
  await page.setViewportSize({ width: 1000, height: 400 });
  await page.goto("/");
  await page.evaluate(async () => (window as unknown as { klaka: { token(): Promise<string> } }).klaka.token());

  await expect.poll(() => events.find((e) => e.type === "view")).toBeTruthy();
  const view = events.find((e) => e.type === "view")!;
  expect(view).toMatchObject({ post: "p-1001", vp: [1000, 400] });
  // Playwright-ov Chromium postavlja navigator.webdriver — senzor to javlja, ne odlučuje.
  expect(view.auto).toBe(1);

  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(1_200); // > 500 ms vidljivosti za seen
  await page.evaluate(() => (window as unknown as { klaka: { flush(): void } }).klaka.flush());

  await expect.poll(() => events.find((e) => e.type === "engage")).toBeTruthy();
  const engage = events.find((e) => e.type === "engage")!;
  expect(engage.vid).toBe(view.vid);
  expect(engage.depth_max as number).toBeGreaterThan(900);
  expect((engage.inputs as { ptr: number }).ptr).toBeGreaterThan(0);
  expect(engage.comments_ms).not.toBeNull();
  expect((engage.seen as string[]).length).toBeGreaterThan(0);
  expect(engage.depth_hist as number[]).toHaveLength(10);
  // Collector prima samo cele brojeve; razlomak = tiho odbačen događaj.
  const times = [engage.dwell_ms, engage.visible_ms, engage.first_input_ms, engage.comments_ms, ...(engage.depth_hist as number[])];
  for (const x of times) expect(Number.isInteger(x), `ceo broj: ${String(x)}`).toBe(true);
});
