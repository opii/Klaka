// HTML demo portala. Sve promenljive vrednosti prolaze kroz esc().

import type { Post } from "./content.js";

export interface Comment {
  id: string;
  post: string;
  author: string;
  text: string;
  /** Javni brojač: samo glasovi sa odlukom `count`. */
  score: number;
  t: number;
  /** `shadow` komentar vidi samo autor (`owner`); javno se ne prikazuje. */
  decision: "count" | "shadow";
  /** Kolačić posetioca koji je napisao komentar; `null` za početne komentare. */
  owner: string | null;
  /** Rezultat provere tokena; `null` za početne komentare. */
  token: string | null;
  /** Prebačen u shadow naknadno (verdicts.md §5), posle odluke `count`. */
  retro?: boolean;
}

export interface VoteLog {
  t: number;
  /** Kolačić posetioca koji je glasao — njemu se shadow glas prikazuje kao uračunat. */
  owner: string | null;
  post: string;
  comment: string;
  dir: 1 | -1;
  vid: string | null;
  token: string;
  uses: number | null;
  repeat: boolean | null;
  decision: "count" | "shadow";
  /** Prebačen u shadow naknadno (verdicts.md §5), posle odluke `count`. */
  retro?: boolean;
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
  a { color: var(--accent) }
  .kicker { font: 13px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--muted) }
  h1 { font-size: 30px; line-height: 1.2; margin: 8px 0 16px }
  .demo { font: 13px/1.4 system-ui, sans-serif; border: 1px dashed var(--line); padding: 8px 12px; color: var(--muted) }
  section { font-family: system-ui, sans-serif; font-size: 15px; margin-top: 40px }
  .c { border-top: 1px solid var(--line); padding: 12px 0; display: grid; grid-template-columns: 1fr auto; gap: 8px }
  .a { font-weight: 600 }
  .v { display: flex; align-items: center; gap: 6px }
  button { font: inherit; border: 1px solid var(--line); background: none; color: var(--fg); border-radius: 6px; cursor: pointer }
  button:hover { border-color: var(--accent); color: var(--accent) }
  .v button { width: 32px; height: 32px }
  .s { min-width: 2ch; text-align: center; font-variant-numeric: tabular-nums }
  form { border-top: 1px solid var(--line); padding-top: 16px; display: grid; gap: 10px }
  label { display: grid; gap: 4px; color: var(--muted) }
  input, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px }
  form button { justify-self: start; padding: 8px 16px }
  .posts { list-style: none; padding: 0 }
  .posts li { border-top: 1px solid var(--line); padding: 14px 0 }
  .posts a { font-size: 21px; text-decoration: none }
  .meta { font: 13px system-ui, sans-serif; color: var(--muted) }
  table { border-collapse: collapse; width: 100%; font: 13px system-ui, sans-serif }
  td, th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left }
  .count { color: #1a7f37 } .shadow { color: #b35900 }
`;

function layout(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
${head}
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function homePage(o: { portal: string; posts: { post: Post; comments: number }[] }): string {
  const items = o.posts
    .map(
      ({ post, comments }) => `
    <li><div class="kicker">${esc(post.section)}</div>
      <a href="/p/${esc(post.id)}">${esc(post.title)}</a>
      <div class="meta">${esc(comments)} komentara</div></li>`,
    )
    .join("");
  return layout(
    "Demo portal",
    "",
    `<div class="kicker">${esc(o.portal)}</div>
  <h1>Vesti</h1>
  <ul class="posts">${items}
  </ul>
  <p class="demo">Demo za proof of concept. <a href="/admin">/admin</a> pokazuje šta je uračunato,
  šta je otišlo u shadow i zašto. Pravi portal te podatke nikad ne prikazuje.</p>`,
  );
}

export function articlePage(o: {
  apiPublic: string;
  /** klaka-collector iz browsera; prazno = događaji se ne šalju. */
  collectorPublic: string;
  portal: string;
  post: Post;
  /** Komentari koje ovaj posetilac vidi: javni i njegovi `shadow`. */
  comments: Comment[];
}): string {
  const list = o.comments
    .map(
      (c) => `
      <div class="c" id="${esc(c.id)}" data-comment="${esc(c.id)}" data-klaka-comment="${esc(c.id)}">
        <div><div class="a">${esc(c.author)}</div><div>${esc(c.text)}</div></div>
        <div class="v">
          <button data-dir="1" aria-label="Plus za komentar">+</button>
          <span class="s" data-score>${esc(c.score)}</span>
          <button data-dir="-1" aria-label="Minus za komentar">−</button>
        </div>
      </div>`,
    )
    .join("");
  const paragraphs = o.post.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n  ");
  const snippet = `<script src="/klaka.min.js" data-api="${esc(o.apiPublic)}"${o.collectorPublic ? ` data-collector="${esc(o.collectorPublic)}"` : ""} data-portal="${esc(o.portal)}" data-post="${esc(o.post.id)}" async></script>`;

  return layout(
    o.post.title,
    snippet,
    `<div class="kicker"><a href="/">${esc(o.portal)}</a> · ${esc(o.post.section)}</div>
  <h1>${esc(o.post.title)}</h1>
  ${paragraphs}
  <p class="demo">Demo za proof of concept. <a href="/admin">/admin</a> pokazuje šta je uračunato,
  šta je otišlo u shadow i zašto. Pravi portal te podatke nikad ne prikazuje.</p>

  <section>
    <h2>Komentari</h2>
    ${list}
    <form id="komentar" data-post="${esc(o.post.id)}">
      <label>Ime <input name="author" maxlength="40" required autocomplete="nickname"></label>
      <label>Komentar <textarea name="text" rows="4" maxlength="2000" required data-klaka-compose></textarea></label>
      <button type="submit">Pošalji</button>
    </form>
  </section>
<script>
  // Isti tok za svaki glas i komentar: zaglavlje sa tokenom (ako ga ima). Odgovor servera je
  // isti za count i shadow, pa je i prikaz isti — shadow komentar autor vidi kao i svaki drugi.
  const klakaHeaders = async () => Object.assign({ "Content-Type": "application/json" },
    window.klaka ? await window.klaka.headers() : {});

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-dir]");
    if (!b) return;
    const box = b.closest("[data-comment]");
    const res = await fetch("/api/vote", { method: "POST", headers: await klakaHeaders(),
      body: JSON.stringify({ comment: box.dataset.comment, dir: Number(b.dataset.dir) }) });
    if (res.ok) {
      const s = box.querySelector("[data-score]");
      s.textContent = String(Number(s.textContent) + Number(b.dataset.dir));
    }
  });

  // Snippet sam šalje compose na submit (core/spec/events.md §2); ovde samo slanje i osvežavanje.
  document.getElementById("komentar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const res = await fetch("/api/comment", { method: "POST", headers: await klakaHeaders(),
      body: JSON.stringify({ post: f.dataset.post, author: f.author.value, text: f.text.value }) });
    if (res.ok) location.reload();
  });
</script>`,
  );
}

export function adminPage(votes: VoteLog[], comments: Comment[]): string {
  const rows = votes
    .slice()
    .reverse()
    .map(
      (v) => `<tr>
        <td>${esc(time(v.t))}</td><td>${esc(v.post)}</td>
        <td>${esc(v.comment)}</td><td>${v.dir > 0 ? "+1" : "−1"}</td>
        <td>${esc(v.token)}</td><td>${esc(v.uses)}</td><td>${v.repeat === null ? "" : v.repeat ? "da" : "ne"}</td>
        <td class="${v.decision}">${esc(v.decision)}${v.retro ? " (naknadno)" : ""}</td><td>${esc(v.vid)}</td></tr>`,
    )
    .join("");
  const list = comments
    .slice()
    .reverse()
    .map(
      (c) => `<tr>
        <td>${c.token === null ? "" : esc(time(c.t))}</td><td>${esc(c.post)}</td><td>${esc(c.id)}</td>
        <td>${esc(c.author)}</td><td>${esc(c.text.length > 60 ? c.text.slice(0, 60) + "…" : c.text)}</td>
        <td>${esc(c.token ?? "početni")}</td><td class="${c.decision}">${esc(c.decision)}${c.retro ? " (naknadno)" : ""}</td><td>${esc(c.score)}</td></tr>`,
    )
    .join("");
  return layout(
    "Demo admin",
    "",
    `<div class="kicker">Samo za demo</div>
<h1>Glasovi</h1>
<table><thead><tr><th>vreme (UTC)</th><th>post</th><th>komentar</th><th>glas</th><th>token</th><th>upotrebe</th><th>ponovljen</th><th>odluka</th><th>vid</th></tr></thead>
<tbody>${rows || `<tr><td colspan="9">Još nema glasova.</td></tr>`}</tbody></table>
<h2>Komentari i javni brojač</h2>
<table><thead><tr><th>vreme (UTC)</th><th>post</th><th>ID</th><th>autor</th><th>tekst</th><th>token</th><th>odluka</th><th>skor</th></tr></thead>
<tbody>${list}</tbody></table>
<p><a href="/">← nazad na portal</a></p>`,
  );
}

function time(t: number): string {
  return new Date(t).toISOString().slice(11, 23);
}
