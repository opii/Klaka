// Senzor u browseru. Meri i šalje; ne odlučuje ništa — napadač čita ovaj kod.
// Vidi docs/tech_stack.md §5.
//
// Upotreba bez koda (klasičan <script>):
//   <script src="ppd.min.js" data-api="https://ppd.example.org"
//           data-portal="demo.local" data-post="p-1001" async></script>
// Ili ručno: ppd.init({ api, portal, post }).
//
// Token stiže u: (a) svako polje <input name="ppd_token"> na stranici, (b) ppd.headers()
// za fetch pozive (zaglavlje X-PPD-Token) — oba oblika SDK prihvata (core/spec/sdk.md §1).

import { requestToken, type Options } from "./view.js";

export type { Options };
export const VERSION = "0.1.0";

const FIELD = "ppd_token";
const HEADER = "X-PPD-Token";

let pending: Promise<string | null> | null = null;

/** Posle `load` događaja traži token (ne ranije: HTML članka je keširan na CDN-u). */
export function init(o: Options): Promise<string | null> {
  pending = afterLoad()
    .then(() => requestToken(o))
    .then((t) => {
      if (t) fillForms(t);
      return t;
    });
  return pending;
}

/** Token ovog prikaza, ili `null` ako ga nema (init nije pozvan, ppd-api nedostupan). */
export function token(): Promise<string | null> {
  return pending ?? Promise.resolve(null);
}

/** Zaglavlja za fetch poziv koji šalje glas ili komentar. */
export async function headers(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { [HEADER]: t } : {};
}

/** Upisuje token u sva polja `ppd_token` unutar `root` (npr. za formu dodatu posle učitavanja). */
export function fillForms(t: string, root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>(`input[name="${FIELD}"]`).forEach((i) => {
    i.value = t;
  });
}

function afterLoad(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

// Samopokretanje iz data-* atributa sopstvenog <script> taga.
const self = document.currentScript as HTMLScriptElement | null;
const d = self?.dataset;
if (d?.api && d.portal && d.post) {
  void init({ api: d.api, portal: d.portal, post: d.post });
}
