// Jednokratno: lokalni LLM (Ollama) napiše članke portala sa početnim komentarima u
// content/articles.json. Neutralne vesti iz izmišljenog grada — bez stvarnih imena, stranaka,
// firmi i političkog stava. Ponovo pokrenuto, dopisuje samo članke koji fale (po ID-ju).
//
//   node scripts/write-articles.mjs [samo-prvih-N]
//   OLLAMA_URL (http://ollama:11434), MODEL (gemma3:12b)

import { readFile, writeFile } from "node:fs/promises";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://ollama:11434").replace(/\/+$/, "");
const MODEL = process.env.MODEL ?? "gemma3:12b";
const OUT = new URL("../content/articles.json", import.meta.url);
const AUTHORS = ["Milica", "Dragan", "Jelena", "Stefan", "Ana", "Vesna", "Nikola", "Marko", "Ivan", "Sanja"];

// ID, rubrika, tema. Prva četiri članka (p-1001…p-1004) su ručno pisana u src/content.ts.
const TOPICS = [
  ["p-1005", "grad", "novi raspored odvoza smeća po naseljima"],
  ["p-1006", "grad", "rekonstrukcija gradskog bazena pred leto"],
  ["p-1007", "grad", "akcija sadnje drveća uz reku"],
  ["p-1008", "grad", "otvaranje novog dečjeg vrtića u naselju"],
  ["p-1009", "grad", "zimska služba i plan čišćenja snega"],
  ["p-1010", "kultura", "festival uličnog teatra na trgu"],
  ["p-1011", "kultura", "nova izložba starih fotografija u gradskom muzeju"],
  ["p-1012", "kultura", "obnova starog bioskopa u centru"],
  ["p-1013", "kultura", "književni konkurs za decu i mlade"],
  ["p-1014", "kultura", "koncert gradskog hora povodom jubileja"],
  ["p-1015", "saobraćaj", "nove biciklističke staze kroz centar"],
  ["p-1016", "saobraćaj", "radovi na mostu i privremena izmena saobraćaja"],
  ["p-1017", "saobraćaj", "nova zona naplate parkiranja"],
  ["p-1018", "saobraćaj", "autobuska stanica dobija novu čekaonicu"],
  ["p-1019", "saobraćaj", "semafor i pešački prelaz kod osnovne škole"],
  ["p-1020", "sport", "lokalni fudbalski klub dobija novi teren"],
  ["p-1021", "sport", "prvi gradski polumaraton"],
  ["p-1022", "sport", "školsko prvenstvo u košarci"],
  ["p-1023", "sport", "teretana na otvorenom u parku"],
  ["p-1024", "sport", "plivački klub pred novu sezonu"],
  ["p-1025", "ekonomija", "nova pijaca domaćih zanatlija"],
  ["p-1026", "ekonomija", "cene daljinskog grejanja za novu sezonu"],
  ["p-1027", "ekonomija", "sajam zapošljavanja za mlade"],
  ["p-1028", "ekonomija", "subvencije za solarne panele na kućama"],
  ["p-1029", "ekonomija", "lokalne pekare i cena hleba"],
  ["p-1030", "ekonomija", "novi poslovni inkubator za male firme"],
];

const SCHEMA = {
  type: "object",
  required: ["title", "lead", "paragraphs", "comments"],
  properties: {
    title: { type: "string" },
    lead: { type: "string" },
    paragraphs: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 7 },
    comments: {
      type: "array", minItems: 4, maxItems: 6,
      items: {
        type: "object", required: ["author", "text", "reply_to"],
        properties: { author: { type: "string", enum: AUTHORS }, text: { type: "string" }, reply_to: { type: ["integer", "null"] } },
      },
    },
  },
};

const SYSTEM = `Ti si novinar lokalnog portala u izmišljenom gradu srednje veličine. Pišeš kratke, neutralne,
činjenične vesti na srpskom jeziku, latinicom. Bez stvarnih imena ljudi, stranaka, firmi i gradova,
bez političkog stava i bez ocena — samo šta se dešava, kada, gde i kako utiče na građane.`;

const prompt = (section, topic) => `Napiši vest za rubriku „${section}" na temu: ${topic}.
- title: naslov vesti, do 12 reči, u rečeničnom obliku (veliko samo prvo slovo i imena);
- lead: jedna rečenica koja sažima vest;
- paragraphs: 6 pasusa, svaki 50–70 reči (detalji, rokovi, ko je nadležan, šta kažu građani) —
  ukupno oko 350 reči;
- comments: 5 komentara čitalaca ispod vesti, različitih stavova, dužina i tona (neko se slaže,
  neko sumnja, neko pita, neko dodaje iskustvo iz kraja); autor iz zadate liste, svaki komentar
  od drugog autora; reply_to je redni broj (od 0) komentara na koji se odgovara ili null —
  najviše dva odgovora.`;

/**
 * Odgovor modela kao stream (NDJSON): zaglavlje stiže odmah, pa nema roka čekanja zaglavlja
 * (undici: 300 s), a dug članak na CPU-u traje i duže od toga.
 */
async function chat(section, topic) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: true, format: SCHEMA, options: { temperature: 0.7 },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(section, topic) }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = "";
  let rest = "";
  for await (const chunk of res.body) {
    rest += Buffer.from(chunk).toString("utf8");
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines.filter(Boolean)) text += JSON.parse(line).message?.content ?? "";
  }
  if (rest.trim()) text += JSON.parse(rest).message?.content ?? "";
  return JSON.parse(text);
}

async function write(id, section, topic) {
  let a;
  for (let attempt = 1; ; attempt++) {
    try {
      a = await chat(section, topic);
      break;
    } catch (e) {
      if (attempt >= 2) throw new Error(`${id}: ${e.message}`);
      console.warn(`${id}: ${e.message}, ponovo`);
    }
  }
  // Odgovor samo na raniji komentar istog članka.
  const comments = a.comments.map((c, i) => ({
    author: c.author, text: c.text.trim(),
    reply_to: Number.isInteger(c.reply_to) && c.reply_to >= 0 && c.reply_to < i ? c.reply_to : null,
  }));
  return { id, section, title: sentenceCase(a.title.trim()), lead: a.lead.trim(), paragraphs: a.paragraphs.map((p) => p.trim()), comments };
}

/** „Novi Raspored Odvoza Smeća" → „Novi raspored odvoza smeća": model ponekad piše naslov kao na engleskom. */
function sentenceCase(title) {
  const words = title.split(" ");
  const upper = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  if (words.length < 3 || upper / words.length < 0.6) return title;
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ");
}

const limit = Number(process.argv[2] ?? TOPICS.length);
let done = [];
try {
  done = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  // prvi put
}
for (const [id, section, topic] of TOPICS.slice(0, limit)) {
  if (done.some((a) => a.id === id)) continue;
  const t = Date.now();
  done.push(await write(id, section, topic));
  done.sort((x, y) => x.id.localeCompare(y.id));
  await writeFile(OUT, JSON.stringify(done, null, 2) + "\n");
  console.log(`${id} (${section}) za ${Math.round((Date.now() - t) / 1000)} s`);
}
