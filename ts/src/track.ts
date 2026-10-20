// DOM sloj: kači se na stranicu i hrani akumulatore (engage.ts, compose.ts); šalje `view`,
// `engage` i `compose` (core/spec/events.md §2).

import { Compose } from "./compose.js";
import { Engage } from "./engage.js";
import { depth, referrer, viewport } from "./measure.js";
import type { Sender } from "./send.js";

const TICK_MS = 250;
const PERIODIC_MS = 30_000;
const SEEN_DWELL_MS = 500;

export interface Tracking {
  /** Šalje sažetak čitanja odmah (npr. pre navigacije u SPA). */
  flush(): void;
  /** Za forme koje se šalju preko fetch-a: javlja da je komentar iz `el` poslat. */
  composed(el: HTMLInputElement | HTMLTextAreaElement): void;
}

export function track(vid: string, post: string, sender: Sender): Tracking {
  const now = () => performance.now();
  const engage = new Engage(now());
  const docHeight = () => document.documentElement.scrollHeight;

  sender.push({
    type: "view", vid, t: Date.now(), post,
    ref: referrer(document.referrer),
    variant: null,
    lang: navigator.language || "",
    tz_min: -new Date().getTimezoneOffset(),
    vp: viewport(window.innerWidth, window.innerHeight),
    auto: navigator.webdriver ? 1 : 0,
  });
  sender.flush();

  const onScroll = () => engage.scroll(now(), depth(window.scrollY + window.innerHeight, docHeight()));
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  setInterval(() => {
    engage.tick(now(), document.visibilityState === "visible", depth(window.scrollY + window.innerHeight / 2, docHeight()));
  }, TICK_MS);

  window.addEventListener("keydown", () => engage.input("key", now()), { capture: true, passive: true });
  window.addEventListener(
    "pointerdown",
    (e) => engage.input(e.pointerType === "touch" ? "touch" : "ptr", now()),
    { capture: true, passive: true },
  );

  observeComments(engage, now);

  const sendEngage = () => {
    sender.push({ type: "engage", vid, t: Date.now(), ...engage.snapshot(now()) });
    sender.flush();
  };
  setInterval(sendEngage, PERIODIC_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendEngage();
  });
  window.addEventListener("pagehide", sendEngage);

  const compose = new Map<Element, Compose>();
  const composed = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const c = compose.get(el);
    if (!c) return;
    sender.push({ type: "compose", vid, t: Date.now(), post, ...c.submit(now(), el.value.length) });
    sender.flush();
  };
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-klaka-compose]").forEach((el) => {
    const c = new Compose();
    compose.set(el, c);
    el.addEventListener("focus", () => c.focus(now()));
    el.addEventListener("keydown", () => c.key());
    el.addEventListener("paste", (e) => c.paste((e as ClipboardEvent).clipboardData?.getData("text").length ?? 0));
    el.form?.addEventListener("submit", () => composed(el));
  });

  return { flush: sendEngage, composed };
}

/** `seen`: komentar vidljiv ≥ 50% bar 500 ms neprekidno; `comments_ms`: prvi put išta vidljivo. */
function observeComments(engage: Engage, now: () => number): void {
  if (typeof IntersectionObserver !== "function") return;
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) engage.commentsVisible(now());
        const id = (e.target as HTMLElement).dataset.klakaComment;
        if (!id) continue;
        if (e.intersectionRatio >= 0.5) {
          if (!timers.has(e.target)) {
            timers.set(e.target, setTimeout(() => engage.seenComment(id), SEEN_DWELL_MS));
          }
        } else {
          clearTimeout(timers.get(e.target));
          timers.delete(e.target);
        }
      }
    },
    { threshold: [0, 0.5] },
  );
  document.querySelectorAll("[data-klaka-comment]").forEach((el) => io.observe(el));
}
