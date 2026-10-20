// Tekstovi emulatora (docs/caci.md §2.1): šabloni po ulozi, pseudonimi, parafraze i komentari
// publike. Šabloni su generički — bez teme i strane: sadržaj nije signal za presudu. Komentari
// publike su o članku, svaki svojim rečima (lokalni LLM): organski tekst se ne ponavlja kao
// šablon, pa je on prava mera lažnih pozitiva za tekstualnu dimenziju.

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

/** `n` tekstova uloge, redom kroz šablone (bez parafraze). */
export function templated(templates: string[], n: number, offset = 0): string[] {
  return Array.from({ length: n }, (_, i) => templates[(offset + i) % templates.length]!);
}

export interface Paraphraser {
  /** Parafraza teksta; `null` ako model nije dao upotrebljiv odgovor. */
  paraphrase(text: string): Promise<string | null>;
}

export interface Writer extends Paraphraser {
  /** Do `n` različitih komentara čitalaca ispod članka sa naslovom `title`. */
  readerComments(title: string, n: number, persona: string): Promise<string[]>;
}

/** Ko piše: svaka grupa komentara dobija drugu mešavinu, da publika ne zvuči kao jedan glas. */
export const PERSONAS = [
  "penzionerka iz kraja, student, mlada majka, taksista",
  "neko ko je skeptičan prema gradskoj upravi, neko ko je zadovoljan, neko ko samo pita",
  "prodavac sa pijace, nastavnik, vozač, neko ko je tek doselio",
  "neko ko piše kratko i bez interpunkcije, neko ko piše dugo i opširno, neko sa malo ironije",
];

const PROMPT = `Preformuliši komentar drugim rečima, sa istim značenjem i tonom, kao da ga piše druga osoba.
Piši na srpskom, latinicom, jednom kratkom rečenicom. Vrati samo novi komentar, bez navodnika i objašnjenja.

Komentar: `;

const READERS_PROMPT = (title: string, n: number, persona: string) => `Ispod članka „${title}" na lokalnom portalu napiši ${n} različitih komentara čitalaca.
Svaki komentar piše druga osoba (na primer: ${persona}), svojim rečima i tonom: neko se slaže,
neko sumnja, neko pita, neko dodaje iskustvo iz svog kraja. Jedna do dve rečenice, srpski, latinica.
Bez numeracije, bez navodnika i bez imena — svaki komentar u svom redu.`;

/** Parafraze i komentari publike preko lokalnog Ollama servisa (docs/llm.md). */
export function ollama(url: string, model: string): Writer & { check(): Promise<void> } {
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
    async readerComments(title, n, persona) {
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: READERS_PROMPT(title, n, persona), stream: false, options: { temperature: 1.0 } }),
      });
      if (!res.ok) return [];
      return lines((await res.json()) as { response?: string }).slice(0, n);
    },
  };
}

/**
 * Komentari iz odgovora sa po jednim u redu: bez numeracije, crtica i navodnika, bez ponavljanja.
 * Red koji se završava dvotačkom je uvod modela („Evo šest komentara čitalaca ispod članka:"), ne
 * komentar — ponavlja se iz izvođenja u izvođenje, pa bi publici pravio lažne šablone.
 */
export function lines(r: { response?: string }): string[] {
  const out: string[] = [];
  for (const raw of (r.response ?? "").split("\n")) {
    const line = raw
      .trim()
      .replace(/^(\d+[.)]|[-*•])\s*/, "")
      .replace(/^["„“”«»']+|["„“”«»']+$/g, "")
      .trim();
    if (line.endsWith(":")) continue;
    if (line.length >= 5 && line.length <= 300 && !out.includes(line)) out.push(line);
  }
  return out;
}

/** Prvi red odgovora, bez navodnika; prazan ili predugačak odgovor nije upotrebljiv. */
export function clean(r: { response?: string }): string | null {
  const line = (r.response ?? "").trim().split("\n")[0]!.trim().replace(/^["„“”«»']+|["„“”«»']+$/g, "").trim();
  return line.length > 0 && line.length <= 300 ? line : null;
}
