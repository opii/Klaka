// Tekstovi emulatora (docs/caci.md §2.1): šabloni po ulozi, pseudonimi, komentari publike i
// parafraze. Šabloni su generički — bez teme i strane: sadržaj nije signal za presudu.

import type { Role } from "./profile.js";

export const TEMPLATES: Record<Role, string[]> = {
  amplifier: [
    "Odlično rečeno.",
    "Potpuno se slažem, bravo.",
    "Ovo je jedini razuman komentar ovde.",
    "Tačno tako, nema šta da se doda.",
    "Konačno neko da kaže kako jeste.",
  ],
  caci: [
    "Sramota, ko ovo uopšte čita.",
    "Smešno, kao i uvek kod vas.",
    "Ovo može da napiše samo neko ko nema pojma.",
    "Sramotan komentar, stidi se.",
    "Idi čitaj nešto drugo i ne pametuj.",
  ],
  diluter: [
    "Lep dan danas, pozdrav svima.",
    "Ima li neko dobar recept za pitu sa jabukama?",
    "Gledao sinoć utakmicu, kakva drama do kraja.",
    "Pozdrav svima koji ovo čitaju uz jutarnju kafu.",
    "Ko još jedva čeka vikend?",
    "Kafa i novine, najbolji početak dana.",
  ],
};

const NAMES = [
  "Goran", "Sneža", "Vlada", "Biljana", "Dejan", "Tanja", "Zoran", "Maja", "Nenad", "Ivana",
  "Bojan", "Jasna", "Saša", "Gordana", "Miloš", "Danijela", "Uroš", "Ljilja", "Darko", "Branka",
];

/** Pseudonim kao na portalu: ime, ponekad sa brojem. */
export function pseudonym(rand: () => number = Math.random): string {
  const name = NAMES[Math.floor(rand() * NAMES.length)]!;
  return rand() < 0.6 ? `${name}${10 + Math.floor(rand() * 90)}` : name;
}

// Komentari publike: sastavljeni iz delova, da se ne ponavljaju doslovno (organski tekst
// nije šablon). Bez teme, kao i šabloni klake — uporedivi su po obliku, ne po sadržaju.
const OPEN = [
  "Iskreno,", "Po meni", "Mislim da", "Koliko ja znam,", "Ne znam za druge, ali", "Zanimljivo,",
  "Pitanje je samo", "Videćemo, ali", "Dobro je što", "Šteta što", "Nadam se da", "Čini mi se da",
];
const BODY = [
  "ovo je trebalo uraditi ranije", "rok je previše optimističan", "niko nije pitao stanare",
  "o ovome se priča godinama", "prošli put je trajalo duplo duže", "cena će na kraju biti veća",
  "to rešava samo deo problema", "detalji tek treba da se vide", "ovakvih vesti bi trebalo da bude više",
  "kod nas u kraju je slično", "ljudi će se brzo navići", "o tome bi trebalo pitati struku",
  "u drugim gradovima to već radi", "važnije je održavanje nego otvaranje",
];
const CLOSE = [".", ".", "!", ", videćemo.", ", ali dobro.", ", nadam se.", " — svaka čast ako uspe.", ", kao i obično."];

export function readerComment(rand: () => number = Math.random): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  return `${pick(OPEN)} ${pick(BODY)}${pick(CLOSE)}`;
}

/** `n` tekstova uloge, redom kroz šablone (bez parafraze). */
export function templated(templates: string[], n: number, offset = 0): string[] {
  return Array.from({ length: n }, (_, i) => templates[(offset + i) % templates.length]!);
}

export interface Paraphraser {
  /** Parafraza teksta; `null` ako model nije dao upotrebljiv odgovor. */
  paraphrase(text: string): Promise<string | null>;
}

const PROMPT = `Preformuliši komentar drugim rečima, sa istim značenjem i tonom, kao da ga piše druga osoba.
Piši na srpskom, latinicom, jednom kratkom rečenicom. Vrati samo novi komentar, bez navodnika i objašnjenja.

Komentar: `;

/** Parafraze preko lokalnog Ollama servisa (docs/llm.md). */
export function ollama(url: string, model: string): Paraphraser & { check(): Promise<void> } {
  const base = url.replace(/\/+$/, "");
  return {
    async check() {
      let names: string[] = [];
      try {
        const res = await fetch(`${base}/api/tags`);
        names = ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name);
      } catch (e) {
        throw new Error(`parafraze traže Ollama na ${base} (${(e as Error).message}); vidi docker compose up -d --wait ollama`);
      }
      if (!names.some((n) => n === model || n === `${model}:latest`)) {
        throw new Error(`Ollama nema model ${model} (ima: ${names.join(", ") || "nijedan"}); vidi servis ollama-pull`);
      }
    },
    async paraphrase(text) {
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: PROMPT + text, stream: false, options: { temperature: 0.9 } }),
      });
      if (!res.ok) return null;
      return clean((await res.json()) as { response?: string });
    },
  };
}

/** Prvi red odgovora, bez navodnika; prazan ili predugačak odgovor nije upotrebljiv. */
export function clean(r: { response?: string }): string | null {
  const line = (r.response ?? "").trim().split("\n")[0]!.trim().replace(/^["„“”«»']+|["„“”«»']+$/g, "").trim();
  return line.length > 0 && line.length <= 300 ? line : null;
}
