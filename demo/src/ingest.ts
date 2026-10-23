// Uvoz vesti sa drugih portala: RSS → predfilter → urednik (lokalni LLM) → članak portala, uz
// potpis i link ka izvoru. Portal ne prenosi tekst izvora: urednik iz njegovih činjenica piše
// kratak, miran sažetak svojim rečima i odbija tračeve, senzacionalizam i sve što nije činjenično.
// Urednik ocenjuje samo ton i činjeničnost — nikad politički stav izvora, teme ili ljudi u vesti.
//
// Okruženje:
//   PORTAL_POSTGRES_URL  baza portala
//   PORTAL_FEEDS         RSS adrese, odvojene zarezom, uz ime izvora: `N1=https://n1info.rs/feed/`
//                        (bez njega: RTS, 021.rs, Danas, N1)
//   OLLAMA_URL           (http://ollama:11434)
//   PORTAL_INGEST_MODEL  (gemma3:12b)
//
//   node dist/ingest.js [najviše-vesti-za-urednika]      (3; model na CPU-u radi minut i duže po vesti)

import { pathToFileURL } from "node:url";

import { SECTIONS } from "./content.js";
import { Db, type IngestEntry } from "./db.js";

export interface Feed {
  name: string;
  url: string;
}

export const DEFAULT_FEEDS: Feed[] = [
  { name: "RTS", url: "https://www.rts.rs/page/stories/sr/rss.html" },
  { name: "021.rs", url: "https://www.021.rs/rss/all" },
  { name: "Danas", url: "https://www.danas.rs/feed/" },
  { name: "N1", url: "https://n1info.rs/feed/" },
];

/** Vest iz feed-a: naslov i tekst kod izvora. */
export interface FeedItem {
  source: string;
  url: string;
  title: string;
  /** Opis iz feed-a (najduži od `content:encoded`, `description`…), bez HTML-a. */
  text: string;
  categories: string[];
}

/** Odgovor urednika: ocena (šema `JUDGE`) i, za prihvaćenu vest, tekst (`WRITE`). */
export interface Verdict {
  reason: string;
  politics: boolean;
  toxicity: number;
  accept: boolean;
  section: string;
  title: string;
  lead: string;
  paragraphs: string[];
}

export interface IngestOptions {
  feeds?: Feed[];
  /** Najviše vesti za urednika u jednom uvozu; ostale čekaju sledeći. */
  limit?: number;
  ollamaUrl?: string;
  model?: string;
  log?: (line: string) => void;
}

const UA = "klaka-demo-portal/0.1 (uvoz vesti; lokalni demo)";
const UA_TOKEN = "klaka-demo-portal";
const FETCH_TIMEOUT_MS = 15_000;
const EDITOR_TIMEOUT_MS = 15 * 60_000;
const MAX_PAGE = 3 * 1024 * 1024;
const PER_FEED = 30;
/** Kraći opis iz feed-a od ovoga: tekst se čita sa stranice vesti. */
const MIN_TEXT = 700;
/** Ispod ovoga stranica nema tekst vesti (traži se širi deo stranice). */
const MIN_USABLE = 250;
/**
 * Ispod ovoga urednik nema dovoljno činjenica za 4–5 pasusa i počinje da dopisuje pozadinu i
 * tumačenja, pa vest ne dobija.
 */
const MIN_EDIT = 800;
const MAX_SOURCE = 6_000;
const MAX_TOXICITY = 2;
const PARAGRAPHS = { min: 4, max: 5 };

/** `PORTAL_FEEDS`: `Ime=https://…` ili samo adresa (ime je onda domen). */
export function parseFeeds(spec: string | undefined): Feed[] {
  if (!spec?.trim()) return DEFAULT_FEEDS;
  return spec.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const eq = x.search(/=https?:\/\//i);
    const url = eq > 0 ? x.slice(eq + 1) : x;
    return { name: eq > 0 ? x.slice(0, eq).trim() : new URL(url).hostname.replace(/^www\./, ""), url };
  });
}

/** Jedan uvoz: novi članci iz feed-ova; vraća zapise dnevnika za obrađene vesti. */
export async function ingest(db: Db, o: IngestOptions = {}): Promise<IngestEntry[]> {
  const log = o.log ?? (() => {});
  const editor = {
    url: (o.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://ollama:11434").replace(/\/+$/, ""),
    model: o.model ?? process.env.PORTAL_INGEST_MODEL ?? "gemma3:12b",
  };
  const perFeed: FeedItem[][] = [];
  for (const f of o.feeds ?? parseFeeds(process.env.PORTAL_FEEDS)) {
    try {
      perFeed.push(parseFeed(await getText(f.url), f.name).slice(0, PER_FEED));
    } catch (e) {
      log(`${f.name}: feed nedostupan (${(e as Error).message})`);
    }
  }
  // Naizmenično po izvorima, da jedan feed ne potroši ceo uvoz.
  const items: FeedItem[] = [];
  for (let i = 0; perFeed.some((l) => i < l.length); i++) for (const l of perFeed) if (l[i]) items.push(l[i]!);
  const seen = await db.seenUrls(items.map((x) => x.url));
  const out: IngestEntry[] = [];
  let edited = 0;
  for (const item of items) {
    if (edited >= (o.limit ?? 3)) break;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const r = await one(db, item, editor);
    if (r.edited) edited++;
    log(describe(r.entry));
    out.push(r.entry);
  }
  return out;
}

async function one(db: Db, item: FeedItem, editor: { url: string; model: string }): Promise<{ entry: IngestEntry; edited: boolean }> {
  const base = { url: item.url, t: Date.now(), source: item.source, title: item.title, toxicity: null, post: null };
  const done = async (outcome: IngestEntry["outcome"], reason: string, more: Partial<IngestEntry> = {}, edited = false) => {
    const entry: IngestEntry = { ...base, outcome, reason, ...more };
    await db.recordIngest(entry);
    return { entry, edited };
  };

  const why = noise(item) ?? outside(item);
  if (why) return done("skipped", why);

  let text = item.text;
  if (text.length < MIN_TEXT) {
    if (!(await robotsAllow(item.url))) {
      if (text.length < MIN_USABLE) return done("skipped", "robots.txt ne dozvoljava čitanje stranice, opis prekratak");
    } else {
      try {
        const page = articleText(await getText(item.url), item.title);
        if (page.length > text.length) text = page;
      } catch (e) {
        if (text.length < MIN_USABLE) return done("error", `stranica vesti: ${(e as Error).message}`);
      }
    }
  }
  if (text.length < MIN_EDIT) return done("skipped", `premalo teksta (${text.length} znakova)`);
  const politics = politicsIn(item, text);
  if (politics) return done("skipped", politics);

  const source = latin(text).slice(0, MAX_SOURCE);
  let v: Verdict;
  try {
    v = await review(editor, item, source);
  } catch (e) {
    return done("error", `urednik: ${(e as Error).message}`, {}, true);
  }
  const d = decide(v, source.length);
  if (!d.ok) return done(d.retry ? "error" : "rejected", d.reason, { toxicity: d.toxicity }, true);
  const post = await db.insertImported(
    { ...d.post, source: { name: item.source, url: item.url }, toxicity: v.toxicity, published_ms: Date.now() },
    { ...base, reason: v.reason.trim() || null, toxicity: v.toxicity },
  );
  if (!post) return { entry: { ...base, outcome: "skipped", reason: "već objavljena" }, edited: true };
  return { entry: { ...base, outcome: "accepted", reason: v.reason.trim() || null, toxicity: v.toxicity, post }, edited: true };
}

function describe(e: IngestEntry): string {
  const tox = e.toxicity === null ? "" : ` (toksičnost ${e.toxicity})`;
  const head = { accepted: `objavljena ${e.post}`, rejected: "odbijena", skipped: "preskočena", error: "greška" }[e.outcome];
  return `${head} [${e.source}] ${latin(e.title)}${tox}${e.reason ? ` — ${e.reason}` : ""}`;
}

// --- predfilter -------------------------------------------------------------------------------

/** Tabloidne reči u naslovu (velikim slovima, kao u tabloidima). */
const LOUD = /(?<![\p{L}\p{N}])(FOTO|VIDEO|ŠOK|SKANDAL|HOROR|UŽAS)(?![\p{L}\p{N}])/u;
const TOPICS: [RegExp, string][] = [
  [/rijaliti|rialiti|reality/u, "rijaliti"],
  [/crn[aeoi]j? hronik/u, "crna hronika"],
  [/kladion|klađen|kladjen/u, "kladionice"],
];

/** Predfilter bez modela: razlog za preskakanje ili `null`. Ćirilica se poredi preslovljena. */
export function noise(item: Pick<FeedItem, "title" | "categories" | "url">): string | null {
  const loud = latin(item.title).match(LOUD);
  if (loud) return `predfilter: ${loud[1]} u naslovu`;
  const where = latin([item.title, ...item.categories].join(" | ")).toLowerCase();
  for (const [re, why] of TOPICS) if (re.test(where)) return `predfilter: ${why}`;
  const path = new URL(item.url).pathname.toLowerCase();
  if (/(^|\/)(crna-)?hronika(\/|$)/.test(path) || item.categories.some((c) => latin(c).toLowerCase() === "hronika")) {
    return "predfilter: crna hronika";
  }
  return null;
}

/** Rubrike izvora van pet rubrika portala (cela rubrika ili deo adrese, latinicom). */
const OUTSIDE = new Set([
  "svet", "region", "world", "news", "lifestyle", "zabava", "showbiz", "magazin", "video", "recepti", "horoskop",
  "zivot", "život", "porodica i dom", "lični stavovi", "licni stavovi", "kolumne", "kolumna", "mišljenja",
  "misljenja i intervjui", "intervju", "najave emisija", "bbc news na srpskom",
]);

/** Vest iz rubrike koje portal nema: urednik bi je odbio („nijedna"), a ovako ne troši model. */
export function outside(item: Pick<FeedItem, "categories" | "url">): string | null {
  const path = new URL(item.url).pathname.toLowerCase().replaceAll("-", " ").split("/");
  const hit = [...item.categories.slice(0, 1).map((c) => latin(c).toLowerCase().trim()), ...path.slice(0, -1)]
    .find((c) => OUTSIDE.has(c));
  return hit ? `predfilter: van rubrika (${hit})` : null;
}

/** Izborne reči: u naslovu i uvodu teksta znače da je vest o izborima. */
const ELECTION = /izbori|izborima|izborn|predizborn|biračk|birališt|cenzus/u;
/** Rubrika izvora ili deo adrese (ceo): „Politika", „Izbori 2026", `/izbori-2026/`. */
const POLITICS_SECTION = /^(politika|izbori ?\d{0,4})$/u;

/**
 * Politika i izbori, bez modela: portal nema političku rubriku, pa takve vesti ne prenosi — bez
 * obzira na to o kome su. Granica je tema (rubrika izvora, izborne reči), ne stav.
 */
export function politicsIn(item: Pick<FeedItem, "title" | "categories" | "url">, text: string): string | null {
  const why = "predfilter: politika i izbori (portal nema političku rubriku)";
  const path = new URL(item.url).pathname.toLowerCase().replaceAll("-", " ").split("/");
  const sections = [...item.categories.map((c) => latin(c).toLowerCase().trim()), ...path];
  if (sections.some((c) => POLITICS_SECTION.test(c) || ELECTION.test(c))) return why;
  return ELECTION.test(latin(`${item.title} ${text.slice(0, 400)}`).toLowerCase()) ? why : null;
}

// --- urednik (Ollama) -------------------------------------------------------------------------

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Prvi korak: ocena. Redosled polja je redosled pisanja — tema i rubrika pre odluke. */
const JUDGE = {
  type: "object",
  required: ["reason", "politics", "section", "toxicity", "accept"],
  properties: {
    reason: { type: "string" },
    politics: { type: "boolean" },
    section: { type: "string", enum: [...SECTION_IDS, "nijedna"] },
    toxicity: { type: "integer", enum: [1, 2, 3, 4, 5] },
    accept: { type: "boolean" },
  },
};

/** Drugi korak, samo za prihvaćenu vest: tekst (broj pasusa drži gramatika šeme). */
const WRITE = {
  type: "object",
  required: ["title", "lead", "paragraphs"],
  properties: {
    title: { type: "string" },
    lead: { type: "string" },
    paragraphs: { type: "array", items: { type: "string" }, minItems: PARAGRAPHS.min, maxItems: PARAGRAPHS.max },
  },
};

const SYSTEM = `Ti si urednik lokalnog portala. Dobijaš vest sa drugog portala i odlučuješ da li je portal
prenosi kao kratak činjenični sažetak, napisan tvojim rečima, uz potpis i link ka izvoru.

Procenjuješ samo ton i činjeničnost. Nikad ne procenjuješ politički stav izvora, teme ili ljudi u
vesti: ista pravila važe za svakoga.`;

const JUDGE_TASK = `Oceni vest:
- reason: jedna kratka rečenica, zašto prihvataš ili odbijaš.
- politics: true ako je vest o izborima, izbornoj kampanji, strankama i izbornim listama,
  političkim skupovima i protestima, anketama rejtinga, političarima i njihovim izjavama. Portal
  nema političku rubriku i takve vesti ne prenosi, bez obzira na to o kome je reč.
- section: ${SECTION_IDS.join(", ")} — grad su komunalne službe, uprava i javne usluge
  (dokumenti, šalteri, katastar), obrazovanje, zdravstvo i vreme; ekonomija su firme, posao,
  cene, nekretnine i porezi. Kada vest ne pripada nijednoj od ovih rubrika (politika, vesti iz
  sveta), section je "nijedna".
- toxicity, od 1 do 5: 1 smiren i činjeničan ton; 2 činjeničan, uz poneku emotivnu reč; 3
  senzacionalan naslov ili ton; 4 uvredljiv, huškački ili ponižavajući; 5 govor mržnje.
- accept: true samo ako vest iznosi činjenice (šta se desilo, gde, kada, prema čijim navodima), od
  javnog je interesa za građane i pripada rubrici. false za politiku, tračeve, rijaliti, horoskop,
  recepte i savete, reklame i nagradne igre, kladionice, crnu hroniku, kolumne i mišljenja,
  glasine bez izvora.`;

const WRITE_TASK = `Napiši vest za portal, na srpskom jeziku, latinicom:
- title: miran naslov u rečeničnom obliku (veliko samo prvo slovo i imena), do 12 reči, bez
  uzvika i bez reči poput ŠOK, FOTO, VIDEO;
- lead: jedna rečenica koja sažima vest;
- paragraphs: ${PARAGRAPHS.min} do ${PARAGRAPHS.max} pasusa — svaki pasus poseban element niza, 30–70 reči,
  neutralno i samo sa činjenicama iz izvora. Izjave prenosiš uz to ko ih je dao. Ne prepisuješ
  rečenice izvora. Nikad ne dopunjuješ pozadinom, opštim rečenicama, tumačenjima ni ocenama kojih
  u izvoru nema: sažetak je kraći od izvora.`;

const prompt = (item: FeedItem, text: string) => `Izvor: ${item.source}
Naslov: ${item.title}
Rubrike izvora: ${item.categories.join(", ") || "—"}
Tekst:
${text}

${JUDGE_TASK}`;

/**
 * Urednik u dva koraka istog razgovora: ocena (kratak odgovor — odbijena vest staje tu), pa tekst
 * prihvaćene. Drugi korak nastavlja razgovor, pa model ne obrađuje izvor ponovo (keš prefiksa).
 */
async function review(editor: { url: string; model: string }, item: FeedItem, text: string): Promise<Verdict> {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(item, text) }];
  const judged = await chat(editor, messages, JUDGE);
  const j = JSON.parse(judged) as Omit<Verdict, "title" | "lead" | "paragraphs">;
  const empty = { title: "", lead: "", paragraphs: [] };
  if (!j.accept || j.politics || j.toxicity > MAX_TOXICITY || !SECTION_IDS.includes(j.section)) return { ...j, ...empty };
  messages.push({ role: "assistant", content: judged }, { role: "user", content: WRITE_TASK });
  return { ...j, ...(JSON.parse(await chat(editor, messages, WRITE)) as typeof empty) };
}

/**
 * Odgovor modela kao stream (NDJSON): zaglavlje stiže odmah, pa nema roka čekanja zaglavlja
 * (undici: 300 s), a obrada dugog teksta na CPU-u traje i duže od toga.
 */
async function chat(editor: { url: string; model: string }, messages: { role: string; content: string }[], format: object): Promise<string> {
  const res = await fetch(`${editor.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: editor.model, stream: true, format, options: { temperature: 0.2, num_ctx: 8192 }, messages }),
    signal: AbortSignal.timeout(EDITOR_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  let content = "";
  let rest = "";
  for await (const chunk of res.body) {
    rest += Buffer.from(chunk).toString("utf8");
    const lines = rest.split("\n");
    rest = lines.pop()!;
    for (const line of lines.filter(Boolean)) content += (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? "";
  }
  if (rest.trim()) content += (JSON.parse(rest) as { message?: { content?: string } }).message?.content ?? "";
  return content;
}

type Decision =
  | { ok: true; post: { section: string; title: string; lead: string; paragraphs: string[] } }
  | { ok: false; reason: string; toxicity: number | null; retry: boolean };

/**
 * Odluka iz odgovora urednika; tema, prag toksičnosti, rubrika i dužina se proveravaju i ovde, ne
 * samo u modelu. `sourceLength`: znakova izvora koje je urednik dobio.
 */
export function decide(v: Verdict, sourceLength: number): Decision {
  const toxicity = Number.isInteger(v.toxicity) && v.toxicity >= 1 && v.toxicity <= 5 ? v.toxicity : null;
  if (toxicity === null) return { ok: false, reason: "urednik: neispravna ocena toksičnosti", toxicity, retry: true };
  const reason = typeof v.reason === "string" ? v.reason.trim() : "";
  if (v.politics) return { ok: false, reason: `politika i izbori${reason ? `: ${reason}` : ""}`, toxicity, retry: false };
  if (!v.accept) return { ok: false, reason: reason || "urednik: odbijena", toxicity, retry: false };
  if (toxicity > MAX_TOXICITY) return { ok: false, reason: `toksičnost ${toxicity} > ${MAX_TOXICITY}${reason ? `: ${reason}` : ""}`, toxicity, retry: false };
  if (!SECTION_IDS.includes(v.section)) return { ok: false, reason: `van rubrika${reason ? `: ${reason}` : ""}`, toxicity, retry: false };
  const clean = (s: unknown) => (typeof s === "string" ? latin(s).replace(/\s+/g, " ").trim() : "");
  const title = sentenceCase(clean(v.title).replace(/^["„“”']+|["„“”']+$/g, "").replace(/!+$/, ""));
  const lead = clean(v.lead);
  const paragraphs = (Array.isArray(v.paragraphs) ? v.paragraphs : []).map(clean).filter((p) => p.length >= 40);
  // Nepotpun tekst nije sud o vesti: pokušava se ponovo pri sledećem uvozu.
  if (!title || !lead || paragraphs.length < PARAGRAPHS.min) {
    return { ok: false, reason: `urednik: nepotpun tekst (${paragraphs.length} pasusa)`, toxicity, retry: true };
  }
  const written = [lead, ...paragraphs].join(" ").length;
  if (written > sourceLength) {
    return { ok: false, reason: `sažetak duži od izvora (${written} > ${sourceLength} znakova): dopisano`, toxicity, retry: false };
  }
  return { ok: true, post: { section: v.section, title: title.slice(0, 160), lead, paragraphs: paragraphs.slice(0, PARAGRAPHS.max) } };
}

/** „Novi Raspored Odvoza Smeća" → „Novi raspored odvoza smeća": model ponekad piše naslov kao na engleskom. */
function sentenceCase(title: string): string {
  const words = title.split(" ");
  const upper = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  if (words.length < 3 || upper / words.length < 0.6) return title;
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ");
}

// --- RSS i stranice vesti ---------------------------------------------------------------------

/** RSS 2.0 i Atom, bez zavisnosti: dovoljno za feed-ove vesti. */
export function parseFeed(xml: string, source: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const it = m[2]!;
    const title = plain(tag(it, "title"));
    const link = tag(it, "link").trim() || (it.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1] ?? "") || tag(it, "guid").trim();
    const url = normalizeUrl(decode(link));
    if (!title || !url) continue;
    const text = ["content:encoded", "description", "content", "summary"]
      .map((t) => plain(tag(it, t)))
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    const categories = [
      ...[...it.matchAll(/<category(?=[\s>])[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => plain(cdata(c[1]!))),
      ...[...it.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)].map((c) => decode(c[1]!)),
    ].filter(Boolean);
    out.push({ source, url, title, text, categories });
  }
  return out;
}

/**
 * Tekst vesti sa stranice, bez zavisnosti: od naslova (`<h1>` kao u feed-u) naviše do prvog
 * pretka sa dovoljno teksta, pa njegovi tekstualni blokovi — bez navigacije, komentara, deljenja,
 * reklama i najava drugih vesti.
 */
export function articleText(html: string, title: string): string {
  const root = parseHtml(html);
  const all: El[] = [];
  (function walk(e: El) {
    all.push(e);
    for (const k of e.kids) if (typeof k !== "string") walk(k);
  })(root);
  const key = (s: string) => latin(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 40);
  const h1s = all.filter((e) => e.tag === "h1");
  const anchor = h1s.find((e) => key(textOf(e)) === key(title)) ?? h1s[0] ?? null;
  const inside = (e: El) => {
    for (let a: El | null = anchor; a; a = a.parent) if (a === e) return true;
    return false;
  };
  const blocks = (e: El, out: string[]): string[] => {
    if (SKIP.has(e.tag) || (negative(e) && !inside(e))) return out;
    if (BLOCK.has(e.tag) && isInline(e)) {
      const t = textOf(e).replace(/\s+/g, " ").trim();
      if (t.length >= 40 && linkText(e).trim().length / t.length < 0.5 && !BOILERPLATE.test(t)) out.push(t);
      return out;
    }
    // `<article>` bez naslova vesti, sa malo teksta, najava je druge vesti.
    if (e.tag === "article" && anchor && !inside(e) && blocks({ ...e, tag: "div" }, []).join("").length < 400) return out;
    for (const k of e.kids) if (typeof k !== "string") blocks(k, out);
    return out;
  };
  let region: El = anchor ?? root;
  while (region.parent && blocks(region, []).join("\n\n").length < MIN_USABLE) region = region.parent;
  return blocks(region, []).join("\n\n");
}

interface El {
  tag: string;
  /** `class` i `id`. */
  cls: string;
  kids: (El | string)[];
  parent: El | null;
}

const VOID = new Set(["area", "base", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Nikad tekst vesti; `a` kao blok je najava ili reklama. */
const SKIP = new Set(["nav", "header", "footer", "aside", "form", "figure", "button", "select", "a"]);
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "em", "i", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);
const BLOCK = new Set(["p", "div", "li", "blockquote", "h2", "h3", "h4"]);
const NEGATIVE = new Set([
  "comment", "comments", "komentar", "komentari", "share", "social", "related", "cookie", "cookies", "consent", "gdpr",
  "banner", "promo", "newsletter", "sidebar", "widget", "ad", "ads", "advert", "oglas", "oglasi", "popular", "tags",
  "breadcrumb", "breadcrumbs", "recommended", "cta", "subscribe",
]);
const BOILERPLATE = /pratite nas|pretplatite se|preuzmite (našu )?aplikaciju|kolačić|cookies|komentari čitalaca/i;

const negative = (e: El) => e.cls.toLowerCase().split(/[\s_-]+/).some((t) => NEGATIVE.has(t));
const isInline = (e: El): boolean => e.kids.every((k) => typeof k === "string" || (INLINE.has(k.tag) && isInline(k)));
const textOf = (e: El): string => e.kids.map((k) => (typeof k === "string" ? k : textOf(k))).join("");
const linkText = (e: El): string => e.kids.map((k) => (typeof k === "string" ? "" : k.tag === "a" ? textOf(k) : linkText(k))).join("");

/** Stablo elemenata, tolerantno na nezatvorene oznake (zatvaranje traži najbližeg istog pretka). */
function parseHtml(html: string): El {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const root: El = { tag: "#root", cls: "", kids: [], parent: null };
  let cur = root;
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      cur.kids.push(decode(m[4]));
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      for (let e: El | null = cur; e?.parent; e = e.parent) {
        if (e.tag === tag) {
          cur = e.parent;
          break;
        }
      }
      continue;
    }
    if (tag === "br") cur.kids.push("\n");
    if (tag === "br" || VOID.has(tag) || m[3]!.endsWith("/")) continue;
    if (tag === "p" && cur.tag === "p") cur = cur.parent!;
    const attr = (n: string) => m[3]!.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)`, "i"))?.[1] ?? "";
    const el: El = { tag, cls: `${attr("class")} ${attr("id")}`, kids: [], parent: cur };
    cur.kids.push(el);
    cur = el;
  }
  return root;
}

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_.*|fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?=[\\s>/])[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? cdata(m[1]!) : "";
}

/** Sadržaj elementa: CDATA doslovno, inače sa razrešenim XML entitetima. */
function cdata(s: string): string {
  const c = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return c ? c[1]! : decode(s);
}

/** HTML → tekst: bez oznaka, sa razrešenim entitetima i pasusima odvojenim praznim redom. */
function plain(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .replace(/The post .* appeared first on .*$/s, "")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
  scaron: "š", Scaron: "Š", zcaron: "ž", Zcaron: "Ž", ccaron: "č", Ccaron: "Č", cacute: "ć", Cacute: "Ć",
  dstrok: "đ", Dstrok: "Đ", euro: "€", deg: "°", copy: "©",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e] ?? all;
  });
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i", ј: "j", к: "k", л: "l",
  љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "ć", у: "u", ф: "f", х: "h",
  ц: "c", ч: "č", џ: "dž", ш: "š",
};

/** Ćirilica → latinica (RTS piše ćirilicom); „ЉУБАВ" → „LJUBAV", „Љубав" → „Ljubav". */
export function latin(s: string): string {
  const chars = [...s];
  return chars
    .map((ch, i) => {
      const lower = ch.toLowerCase();
      const t = CYRILLIC[lower];
      if (t === undefined) return ch;
      if (ch === lower) return t;
      const next = chars[i + 1] ?? "";
      const caps = next !== next.toLowerCase() || (next === "" && (chars[i - 1] ?? "") !== (chars[i - 1] ?? "").toLowerCase());
      return caps ? t.toUpperCase() : t[0]!.toUpperCase() + t.slice(1);
    })
    .join("");
}

// --- mreža ------------------------------------------------------------------------------------

async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_PAGE) throw new Error("prevelika strana");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ROBOTS_TTL_MS = 60 * 60_000;
const robots = new Map<string, { at: number; rules: Promise<RegExp[]> }>();

/** Stranica vesti se čita samo ako robots.txt izvora to dozvoljava (pravila za `*` i za nas). */
async function robotsAllow(url: string): Promise<boolean> {
  const u = new URL(url);
  let entry = robots.get(u.origin);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL_MS) {
    entry = { at: Date.now(), rules: getText(`${u.origin}/robots.txt`).then(parseRobots, () => []) };
    robots.set(u.origin, entry);
  }
  const path = u.pathname + u.search;
  return !(await entry.rules).some((re) => re.test(path));
}

/**
 * `Disallow` iz grupa za `*` i za naš user-agent, kao regex (`*` i `$` po RFC 9309). `Allow`
 * se ne gleda: strože od pravila, ali nikad ne čita ono što je zabranjeno.
 */
export function parseRobots(txt: string): RegExp[] {
  const out: RegExp[] = [];
  let agents: string[] = [];
  let rules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (rules) agents = [];
      rules = false;
      agents.push(value.toLowerCase());
    } else if (key === "disallow" || key === "allow") {
      rules = true;
      if (key === "disallow" && value && agents.some((a) => a === "*" || UA_TOKEN.startsWith(a))) {
        const anchored = value.endsWith("$");
        const body = (anchored ? value.slice(0, -1) : value).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        out.push(new RegExp(`^${body}${anchored ? "$" : ""}`));
      }
    }
  }
  return out;
}

// --- komandna linija --------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PORTAL_POSTGRES_URL) throw new Error("PORTAL_POSTGRES_URL nije postavljen");
  const db = await Db.open(process.env.PORTAL_POSTGRES_URL);
  try {
    const done = await ingest(db, { limit: Number(process.argv[2] ?? 3), log: (l) => console.log(l) });
    console.log(`uvoz: ${done.filter((e) => e.outcome === "accepted").length} objavljenih od ${done.length} obrađenih`);
  } finally {
    await db.close();
  }
}
