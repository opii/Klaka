// Senzor u browseru. Meri i šalje; ne odlučuje ništa — napadač čita ovaj kod.
// Vidi docs/tech_stack.md §5.
//
// Upotreba bez koda (klasičan <script>):
//   <script src="klaka.min.js" data-api="https://klaka.example.org"
//           data-collector="https://collector.example.org"
//           data-portal="demo.local" data-post="p-1001" async></script>
// Ili ručno: klaka.init({ api, collector, portal, post }).
//
// Token stiže u: (a) svako polje <input name="klaka_token"> na stranici, (b) klaka.headers()
// za fetch pozive (zaglavlje X-Klaka-Token) — oba oblika SDK prihvata (core/spec/sdk.md §1).
// Sa `collector`-om šalje i događaje `view`, `engage`, `compose` (core/spec/events.md §2).

import { Sender } from "./send.js";
import { track, type Tracking } from "./track.js";
import { requestView, type Options } from "./view.js";

export type { Options };
export const VERSION = "0.2.0";

const FIELD = "klaka_token";
const HEADER = "X-Klaka-Token";

let pending: Promise<string | null> | null = null;
let tracking: Tracking | null = null;

/** Posle `load` događaja traži token (ne ranije: HTML članka je keširan na CDN-u). */
export function init(o: Options): Promise<string | null> {
  pending = afterLoad()
    .then(() => requestView(o))
    .then((v) => {
      if (!v) return null;
      fillForms(v.token);
      if (o.collector) {
        const url = o.collector.replace(/\/+$/, "") + "/v1/events";
        tracking = track(v.vid, o.post, new Sender(url, o.portal));
      }
      return v.token;
    });
  return pending;
}

/** Token ovog prikaza, ili `null` ako ga nema (init nije pozvan, klaka-api nedostupan). */
export function token(): Promise<string | null> {
  return pending ?? Promise.resolve(null);
}

/** Zaglavlja za fetch poziv koji šalje glas ili komentar. */
export async function headers(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { [HEADER]: t } : {};
}

/** Upisuje token u sva polja `klaka_token` unutar `root` (npr. za formu dodatu posle učitavanja). */
export function fillForms(t: string, root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>(`input[name="${FIELD}"]`).forEach((i) => {
    i.value = t;
  });
}

/** Šalje sažetak čitanja odmah (SPA navigacija; inače ide sam na `pagehide`). */
export function flush(): void {
  tracking?.flush();
}

/** Komentar iz polja `data-klaka-compose` je poslat fetch-om (za obične forme ide samo). */
export function composed(el: HTMLInputElement | HTMLTextAreaElement): void {
  tracking?.composed(el);
}

function afterLoad(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

// Samopokretanje iz data-* atributa sopstvenog <script> taga.
const self = document.currentScript as HTMLScriptElement | null;
const d = self?.dataset;
if (d?.api && d.portal && d.post) {
  void init({ api: d.api, portal: d.portal, post: d.post, ...(d.collector ? { collector: d.collector } : {}) });
}
