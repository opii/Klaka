// HTML demo portala. Sve promenljive vrednosti prolaze kroz esc().

export interface Comment {
  id: string;
  author: string;
  text: string;
  /** Javni brojač: samo glasovi sa odlukom `count`. */
  score: number;
}

export interface VoteLog {
  t: number;
  comment: string;
  dir: 1 | -1;
  vid: string | null;
  token: string;
  uses: number | null;
  repeat: boolean | null;
  decision: "count" | "shadow";
}

export function esc(s: string | number | null): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const STYLE = `
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafaf7; --muted:#6b6b6b; --line:#ddd; --accent:#2457c5 }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e3; --bg:#17181a; --muted:#9a9a9a; --line:#333; --accent:#7aa2ff } }
  body { font: 17px/1.55 Georgia, serif; color: var(--fg); background: var(--bg); margin: 0 }
  main { max-width: 680px; margin: 0 auto; padding: 24px 16px 64px }
  .kicker { font: 13px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--muted) }
  h1 { font-size: 30px; line-height: 1.2; margin: 8px 0 16px }
  .demo { font: 13px/1.4 system-ui, sans-serif; border: 1px dashed var(--line); padding: 8px 12px; color: var(--muted) }
  section { font-family: system-ui, sans-serif; font-size: 15px; margin-top: 40px }
  .c { border-top: 1px solid var(--line); padding: 12px 0; display: grid; grid-template-columns: 1fr auto; gap: 8px }
  .a { font-weight: 600 }
  .v { display: flex; align-items: center; gap: 6px }
  .v button { font: inherit; border: 1px solid var(--line); background: none; color: var(--fg); border-radius: 6px; width: 32px; height: 32px; cursor: pointer }
  .v button:hover { border-color: var(--accent); color: var(--accent) }
  .s { min-width: 2ch; text-align: center; font-variant-numeric: tabular-nums }
  table { border-collapse: collapse; width: 100%; font: 13px system-ui, sans-serif }
  td, th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left }
  .count { color: #1a7f37 } .shadow { color: #b35900 }
`;

export function articlePage(o: {
  apiPublic: string;
  portal: string;
  post: string;
  comments: Comment[];
}): string {
  const list = o.comments
    .map(
      (c) => `
      <div class="c" data-comment="${esc(c.id)}">
        <div><div class="a">${esc(c.author)}</div><div>${esc(c.text)}</div></div>
        <div class="v">
          <button data-dir="1" aria-label="Plus za komentar">+</button>
          <span class="s" data-score>${esc(c.score)}</span>
          <button data-dir="-1" aria-label="Minus za komentar">−</button>
        </div>
      </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo portal</title>
<style>${STYLE}</style>
<script src="/klaka.min.js" data-api="${esc(o.apiPublic)}" data-portal="${esc(o.portal)}" data-post="${esc(o.post)}" async></script>
</head>
<body>
<main>
  <div class="kicker">Grad · ${esc(o.portal)}</div>
  <h1>Park kod reke dobija novu stazu i klupe do proleća</h1>
  <p>Radovi na uređenju parka počinju sledeće nedelje. Predviđene su nova pešačka staza, rasveta
  i trideset klupa. Gradska uprava navodi da će park tokom radova biti delimično otvoren.</p>
  <p>Stanari okolnih zgrada traže i češće odnošenje smeća, a udruženje vlasnika pasa poseban
  ograđen prostor. O oba zahteva odlučivaće se na sednici u decembru.</p>
  <p class="demo">Demo za proof of concept. <a href="/admin">/admin</a> pokazuje šta je uračunato,
  šta je otišlo u shadow i zašto. Pravi portal te podatke nikad ne prikazuje.</p>

  <section>
    <h2>Komentari</h2>
    ${list}
  </section>
</main>
<script>
  // Isti tok za svaki glas: zaglavlje sa tokenom (ako ga ima) i lokalno uvećanje brojača.
  // Odgovor servera je isti za count i shadow, pa je i prikaz isti.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-dir]");
    if (!b) return;
    const box = b.closest("[data-comment]");
    const headers = Object.assign({ "Content-Type": "application/json" },
      window.klaka ? await window.klaka.headers() : {});
    const res = await fetch("/api/vote", { method: "POST", headers,
      body: JSON.stringify({ comment: box.dataset.comment, dir: Number(b.dataset.dir) }) });
    if (res.ok) {
      const s = box.querySelector("[data-score]");
      s.textContent = String(Number(s.textContent) + Number(b.dataset.dir));
    }
  });
</script>
</body>
</html>`;
}

export function adminPage(votes: VoteLog[], comments: Comment[]): string {
  const rows = votes
    .slice()
    .reverse()
    .map(
      (v) => `<tr>
        <td>${esc(new Date(v.t).toISOString().slice(11, 23))}</td>
        <td>${esc(v.comment)}</td><td>${v.dir > 0 ? "+1" : "−1"}</td>
        <td>${esc(v.token)}</td><td>${esc(v.uses)}</td><td>${v.repeat === null ? "" : v.repeat ? "da" : "ne"}</td>
        <td class="${v.decision}">${esc(v.decision)}</td><td>${esc(v.vid)}</td></tr>`,
    )
    .join("");
  const scores = comments.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.score)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo admin</title><style>${STYLE}</style></head>
<body><main>
<div class="kicker">Samo za demo</div>
<h1>Glasovi</h1>
<table><thead><tr><th>vreme (UTC)</th><th>komentar</th><th>glas</th><th>token</th><th>upotrebe</th><th>ponovljen</th><th>odluka</th><th>vid</th></tr></thead>
<tbody>${rows || `<tr><td colspan="8">Još nema glasova.</td></tr>`}</tbody></table>
<h2>Javni brojač</h2>
<table><thead><tr><th>komentar</th><th>skor</th></tr></thead><tbody>${scores}</tbody></table>
<p><a href="/">← nazad na članak</a></p>
</main></body></html>`;
}
