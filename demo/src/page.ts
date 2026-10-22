// HTML portala. Sve promenljive vrednosti prolaze kroz esc().

import { SECTIONS, sectionOf, type Post } from "./content.js";
import type { Account, Comment, Vote } from "./db.js";
import { PAGE, SORTS, type Sort, type Thread } from "./thread.js";

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const STYLE = `
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafaf7; --muted:#6b6b6b; --line:#ddd; --accent:#2457c5; --soft:#f0efe9 }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e3; --bg:#17181a; --muted:#9a9a9a; --line:#333; --accent:#7aa2ff; --soft:#222326 } }
  body { font: 17px/1.55 Georgia, serif; color: var(--fg); background: var(--bg); margin: 0 }
  header { border-bottom: 1px solid var(--line); font-family: system-ui, sans-serif }
  .bar { max-width: 980px; margin: 0 auto; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline }
  .logo { font: 700 22px/1 Georgia, serif; text-decoration: none; color: var(--fg) }
  nav a { color: var(--muted); text-decoration: none; font-size: 14px; margin-right: 14px }
  nav a:hover, nav a.on { color: var(--accent) }
  main { max-width: 680px; margin: 0 auto; padding: 24px 16px 64px }
  main.wide { max-width: 980px }
  a { color: var(--accent) }
  .kicker { font: 13px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--muted) }
  .kicker a { color: inherit; text-decoration: none }
  h1 { font-size: 30px; line-height: 1.2; margin: 8px 0 16px }
  .lead { font-size: 19px; font-weight: 600 }
  .demo { font: 13px/1.4 system-ui, sans-serif; border: 1px dashed var(--line); padding: 8px 12px; color: var(--muted) }
  section { font-family: system-ui, sans-serif; font-size: 15px; margin-top: 40px }
  .tools { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; color: var(--muted); font-size: 14px }
  .tools a.on { font-weight: 700; color: var(--fg); text-decoration: none }
  .c { border-top: 1px solid var(--line); padding: 12px 0; display: grid; grid-template-columns: 1fr auto; gap: 8px }
  .c.reply { margin-left: 28px; border-top-style: dashed }
  .a { font-weight: 600 }
  .when { color: var(--muted); font-size: 12px; margin-left: 6px; font-weight: 400 }
  .v { display: flex; align-items: center; gap: 6px }
  button { font: inherit; border: 1px solid var(--line); background: none; color: var(--fg); border-radius: 6px; cursor: pointer }
  button:hover { border-color: var(--accent); color: var(--accent) }
  .v button { width: 32px; height: 32px }
  button.answer { border: none; padding: 0; color: var(--muted); font-size: 13px; margin-top: 4px }
  .s { min-width: 2ch; text-align: center; font-variant-numeric: tabular-nums }
  .pages { margin: 16px 0; display: flex; gap: 10px; flex-wrap: wrap }
  form { border-top: 1px solid var(--line); padding-top: 16px; display: grid; gap: 10px }
  label { display: grid; gap: 4px; color: var(--muted) }
  input, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px }
  form button { justify-self: start; padding: 8px 16px }
  .to { font-size: 13px; color: var(--muted) }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px }
  .top { display: grid; grid-template-columns: 2fr 1fr; gap: 32px }
  @media (max-width: 720px) { .top { grid-template-columns: 1fr } }
  .story a { text-decoration: none; color: var(--fg) }
  .story a:hover { color: var(--accent) }
  .story h2 { font-size: 26px; line-height: 1.2; margin: 6px 0 }
  .story h3 { font-size: 19px; line-height: 1.25; margin: 6px 0 }
  .story p { margin: 4px 0; color: var(--muted); font-size: 15px }
  .list { list-style: none; padding: 0; margin: 0 }
  .list li { border-top: 1px solid var(--line); padding: 10px 0 }
  .list a { text-decoration: none; color: var(--fg) }
  .meta { font: 13px system-ui, sans-serif; color: var(--muted) }
  h2.block { font: 700 14px system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid var(--fg); padding-bottom: 6px }
  table { border-collapse: collapse; width: 100%; font: 13px system-ui, sans-serif }
  td, th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left }
  .count { color: #1a7f37 } .shadow { color: #b35900 }
  .user { margin-left: auto; font-size: 14px; color: var(--muted); display: flex; gap: 10px; align-items: baseline }
  .user form { display: inline; border: none; padding: 0 }
  .user button { border: none; padding: 0; color: var(--accent); font-size: 14px }
  .reg { color: #1a7f37; font-size: 12px; margin-left: 4px }
  .err { color: #b3261e; font-size: 14px }
  .narrow { max-width: 360px }
  .views { margin: 6px 0 14px; display: flex; gap: 6px; flex-wrap: wrap; font-size: 14px }
  .views a { border: 1px solid var(--line); border-radius: 14px; padding: 2px 10px; text-decoration: none; color: var(--muted) }
  .views a.on { border-color: var(--accent); color: var(--accent); font-weight: 600 }
  .banner { border-left: 3px solid var(--accent); background: var(--soft); padding: 8px 12px; font-size: 14px; margin: 10px 0 }
  .xsum { background: var(--soft); padding: 10px 12px; font-size: 14px; margin: 10px 0 }
  .xsum ul { margin: 6px 0 0; padding-left: 18px }
  .c.hidden-c { opacity: .55 }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px }
  .b { font-size: 12px; border-radius: 4px; padding: 1px 6px; background: var(--soft); color: var(--muted); text-decoration: none }
  .b.shadow-b { background: #fbe9d6; color: #8a4500 } .b.retro-b { background: #fde2e2; color: #9b1c1c }
  .b.verdict-b { background: #e4ecfb; color: #1f4fae }
  @media (prefers-color-scheme: dark) { .b.shadow-b { background: #3a2a18; color: #f0b27a } .b.retro-b { background: #3a1c1c; color: #f2a0a0 } .b.verdict-b { background: #1c2a45; color: #9dbcf5 } }
  .xline { font-size: 12px; color: var(--muted); margin-top: 2px }
`;

/** Ko gleda stranicu (za zaglavlje): prijavljen nalog ili niko. */
export type User = Account | null;

/**
 * Pogled na komentare: javni; kako portal izgleda klaki (svi njeni glasovi i komentari kao
 * uračunati — svaki poslušnik vidi samo svoje, ovde su svi zajedno); i „Rendgen" — šta je
 * Klaka prepoznala.
 */
export type View = "javno" | "poslusnik" | "rendgen";
export const VIEWS: View[] = ["javno", "poslusnik", "rendgen"];
const VIEW_NAMES: Record<View, string> = { javno: "Javno", poslusnik: "Pogled poslušnika", rendgen: "Rendgen" };

/** Napomena uz komentar u pogledima „Poslušnik" i „Rendgen". */
export interface Note {
  /** Posetilac ovaj komentar inače ne vidi (tuđ shadow): bez glasanja i bez `seen`. */
  foreign: boolean;
  badges: { text: string; kind: "shadow" | "retro" | "verdict" | "info"; href?: string }[];
  line?: string;
}

/** Sažetak Rendgena za članak. */
export interface Xray {
  comments: { total: number; public: number; shadow: number; retro: number };
  votes: { total: number; public: number; shadow: number; retro: number };
  verdicts: { label: string; href: string }[];
  /** Presude iz klaka-api su stigle (podešen nalog portala i API dostupan). */
  linked: boolean;
}

function layout(o: {
  title: string; head?: string; body: string; section?: string; wide?: boolean; portal: string; user: User;
}): string {
  const nav = SECTIONS.map(
    (s) => `<a href="/r/${esc(s.slug)}"${s.id === o.section ? ' class="on"' : ""}>${esc(s.name)}</a>`,
  ).join("");
  const user = o.user
    ? `<span class="user">${esc(o.user.pseudonym)}<form method="post" action="/odjava"><button>Odjava</button></form></span>`
    : `<span class="user"><a href="/prijava">Prijava</a><a href="/registracija">Registracija</a></span>`;
  return `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>${STYLE}</style>
${o.head ?? ""}
</head>
<body>
<header><div class="bar"><a class="logo" href="/">${esc(o.portal)}</a><nav>${nav}</nav>${user}</div></header>
<main${o.wide ? ' class="wide"' : ""}>
${o.body}
</main>
</body>
</html>`;
}

const DEMO_NOTE = `<p class="demo">Demo za proof of concept. <a href="/admin">/admin</a> pokazuje šta je uračunato,
  šta je otišlo u shadow i zašto. Pravi portal te podatke nikad ne prikazuje.</p>`;

function storyLink(p: Post, comments: number, big = false): string {
  const s = sectionOf(p.section);
  const h = big ? "h2" : "h3";
  return `<div class="story">
    <div class="kicker">${esc(s?.name ?? p.section)}</div>
    <a href="/p/${esc(p.id)}"><${h}>${esc(p.title)}</${h}></a>
    ${p.lead ? `<p>${esc(p.lead)}</p>` : ""}
    <div class="meta">${esc(comments)} komentara</div>
  </div>`;
}

/** Naslovna: glavna vest, najnovije, najkomentarisanije i blok po rubrici. */
export function homePage(o: { portal: string; user: User; posts: Post[]; comments: Map<string, number> }): string {
  const count = (p: Post) => o.comments.get(p.id) ?? 0;
  const newest = [...o.posts].sort((a, b) => b.id.localeCompare(a.id));
  const [lead, ...rest] = newest;
  const most = [...o.posts].sort((a, b) => count(b) - count(a) || b.id.localeCompare(a.id)).slice(0, 6);
  const blocks = SECTIONS.map((s) => {
    const here = newest.filter((p) => p.section === s.id).slice(0, 3);
    if (here.length === 0) return "";
    return `<div><h2 class="block"><a href="/r/${esc(s.slug)}">${esc(s.name)}</a></h2>
      ${here.map((p) => storyLink(p, count(p))).join("")}</div>`;
  }).join("");
  return layout({
    portal: o.portal,
    user: o.user,
    title: o.portal,
    wide: true,
    body: lead
      ? `<div class="top">
    <div>${storyLink(lead, count(lead), true)}
      <div class="grid" style="margin-top:24px">${rest.slice(0, 4).map((p) => storyLink(p, count(p))).join("")}</div></div>
    <aside><h2 class="block">Najkomentarisanije</h2><ul class="list">${most
      .map((p) => `<li><a href="/p/${esc(p.id)}">${esc(p.title)}</a> <span class="meta">${esc(count(p))}</span></li>`)
      .join("")}</ul></aside>
  </div>
  <div class="grid" style="margin-top:40px">${blocks}</div>
  ${DEMO_NOTE}`
      : "<p>Još nema članaka.</p>",
  });
}

/** Rubrika: svi članci, noviji prvi. */
export function sectionPage(o: {
  portal: string; user: User; section: string; name: string; posts: Post[]; comments: Map<string, number>;
}): string {
  const list = [...o.posts].sort((a, b) => b.id.localeCompare(a.id));
  return layout({
    portal: o.portal,
    user: o.user,
    title: `${o.name} — ${o.portal}`,
    section: o.section,
    wide: true,
    body: `<h1>${esc(o.name)}</h1>
  <div class="grid">${list.map((p) => storyLink(p, o.comments.get(p.id) ?? 0)).join("")}</div>`,
  });
}

function commentBox(c: Comment, reply: boolean, note?: Note): string {
  // Tuđ shadow komentar (samo u pogledima koji ga pokazuju): bez glasanja, odgovora i `seen`.
  const foreign = note?.foreign === true;
  const badges = note?.badges.length
    ? `<div class="badges">${note.badges
        .map((b) => {
          const cls = `b ${b.kind}-b`;
          return b.href
            ? `<a class="${cls}" href="${esc(b.href)}">${esc(b.text)}</a>`
            : `<span class="${cls}">${esc(b.text)}</span>`;
        })
        .join("")}</div>`
    : "";
  const line = note?.line ? `<div class="xline">${esc(note.line)}</div>` : "";
  const attrs = foreign
    ? `class="c${reply ? " reply" : ""} hidden-c" id="${esc(c.id)}"`
    : `class="c${reply ? " reply" : ""}" id="${esc(c.id)}" data-comment="${esc(c.id)}" data-klaka-comment="${esc(c.id)}"`;
  const votes = foreign
    ? `<div class="v"><span class="s">${esc(c.score)}</span></div>`
    : `<div class="v">
          <button data-dir="1" aria-label="Plus za komentar">+</button>
          <span class="s" data-score>${esc(c.score)}</span>
          <button data-dir="-1" aria-label="Minus za komentar">−</button>
        </div>`;
  return `
      <div ${attrs}>
        <div><div class="a">${esc(c.author)}${c.account !== null ? '<span class="reg" title="Registrovan nalog">✓</span>' : ""}<span class="when">${esc(when(c.t))}</span></div><div>${esc(c.text)}</div>
          ${badges}${line}
          ${foreign ? "" : `<button class="answer" type="button" data-reply="${esc(c.id)}" data-author="${esc(c.author)}">Odgovori</button>`}</div>
        ${votes}
      </div>`;
}

export function articlePage(o: {
  user: User;
  apiPublic: string;
  /** klaka-collector iz browsera; prazno = događaji se ne šalju. */
  collectorPublic: string;
  portal: string;
  post: Post;
  /** Niti koje ovaj posetilac vidi (javni i njegovi `shadow` komentari), sortirane. */
  threads: Thread[];
  /** Ukupno komentara koje posetilac vidi. */
  total: number;
  sort: Sort;
  page: number;
  /** Prekidač pogleda (isključen na javnom serveru, `PORTAL_XRAY`). */
  views: boolean;
  view: View;
  notes?: Map<string, Note>;
  xray?: Xray;
}): string {
  const pages = Math.max(1, Math.ceil(o.threads.length / PAGE));
  const shown = o.threads.slice((o.page - 1) * PAGE, o.page * PAGE);
  const box = (c: Comment, reply: boolean) => commentBox(c, reply, o.notes?.get(c.id));
  const list = shown.map((t) => box(t.root, false) + t.replies.map((r) => box(r, true)).join("")).join("");
  const href = (sort: Sort, page: number, view: View = o.view) =>
    `/p/${esc(o.post.id)}?sort=${sort}${page > 1 ? `&strana=${page}` : ""}${view !== "javno" ? `&pogled=${view}` : ""}#komentari`;
  const views = o.views
    ? `<div class="views">${VIEWS.map(
        (v) => `<a href="${href(o.sort, 1, v)}"${v === o.view ? ' class="on"' : ""}>${VIEW_NAMES[v]}</a>`,
      ).join("")}</div>`
    : "";
  const banner =
    o.view === "poslusnik"
      ? `<div class="banner">Ovako portal izgleda klaki: njeni glasovi i komentari se vide kao uračunati,
      iako ih javni zbir ne računa. Svaki poslušnik vidi samo svoje — ovde su svi zajedno.</div>`
      : o.view === "rendgen" && o.xray
        ? xraySummary(o.xray)
        : "";
  const sorts = SORTS.map(
    (s) => `<a href="${href(s, 1)}"${s === o.sort ? ' class="on"' : ""}>${s === "najbolji" ? "Najbolji" : "Najnoviji"}</a>`,
  ).join("");
  const pager =
    pages > 1
      ? `<div class="pages">${Array.from({ length: pages }, (_, i) => i + 1)
          .map((n) => (n === o.page ? `<strong>${n}</strong>` : `<a href="${href(o.sort, n)}">${n}</a>`))
          .join("")}</div>`
      : "";
  const paragraphs = o.post.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n  ");
  const section = sectionOf(o.post.section);
  const snippet = `<script src="/klaka.min.js" data-api="${esc(o.apiPublic)}"${o.collectorPublic ? ` data-collector="${esc(o.collectorPublic)}"` : ""} data-portal="${esc(o.portal)}" data-post="${esc(o.post.id)}" async></script>`;

  const name = o.user
    ? `<label>Ime <input name="author" value="${esc(o.user.pseudonym)}" readonly></label>`
    : `<label>Ime <input name="author" maxlength="40" required autocomplete="nickname"></label>`;
  return layout({
    portal: o.portal,
    user: o.user,
    title: o.post.title,
    head: snippet,
    section: o.post.section,
    body: `<div class="kicker"><a href="/r/${esc(section?.slug ?? "")}">${esc(section?.name ?? o.post.section)}</a></div>
  <h1>${esc(o.post.title)}</h1>
  ${o.post.lead ? `<p class="lead">${esc(o.post.lead)}</p>` : ""}
  ${paragraphs}
  ${DEMO_NOTE}

  <section id="komentari">
    <h2>Komentari (${esc(o.total)})</h2>
    ${views}${banner}
    <div class="tools">Poređaj: ${sorts}</div>
    ${list}
    ${pager}
    <form id="komentar" data-post="${esc(o.post.id)}">
      <input type="hidden" name="reply_to" value="">
      <div class="to" hidden>Odgovor za <strong data-to></strong> · <a href="#" data-cancel>otkaži</a></div>
      ${name}
      <label>Komentar <textarea name="text" rows="4" maxlength="2000" required data-klaka-compose></textarea></label>
      <div class="err" hidden></div>
      <button type="submit">Pošalji</button>
    </form>
  </section>
<script>
  // Isti tok za svaki glas i komentar: zaglavlje sa tokenom (ako ga ima). Odgovor servera je
  // isti za count i shadow, pa je i prikaz isti — shadow komentar autor vidi kao i svaki drugi.
  const klakaHeaders = async () => Object.assign({ "Content-Type": "application/json" },
    window.klaka ? await window.klaka.headers() : {});
  const form = document.getElementById("komentar");
  const to = form.querySelector(".to");

  document.addEventListener("click", async (e) => {
    const answer = e.target.closest("button[data-reply]");
    if (answer) {
      form.reply_to.value = answer.dataset.reply;
      to.querySelector("[data-to]").textContent = answer.dataset.author;
      to.hidden = false;
      form.text.focus();
      return;
    }
    if (e.target.closest("[data-cancel]")) {
      e.preventDefault();
      form.reply_to.value = "";
      to.hidden = true;
      return;
    }
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

  // Snippet sam šalje compose na submit (core/spec/events.md §2); ovde slanje i prelazak na
  // novi komentar (trajni link, jer je nov komentar sa nula glasova možda na drugoj stranici).
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/comment", { method: "POST", headers: await klakaHeaders(),
      body: JSON.stringify({ post: form.dataset.post, author: form.author.value, text: form.text.value,
        reply_to: form.reply_to.value || null }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = form.querySelector(".err");
      err.textContent = body.error === "zauzeto"
        ? "Ime pripada registrovanom nalogu — prijavite se ili izaberite drugo."
        : "Komentar nije poslat.";
      err.hidden = false;
      return;
    }
    const { id } = body;
    location.href = location.pathname + "?komentar=" + encodeURIComponent(id) + "#" + encodeURIComponent(id);
  });
</script>`,
  });
}

function xraySummary(x: Xray): string {
  const c = x.comments;
  const v = x.votes;
  const verdicts = x.verdicts.length
    ? `<ul>${x.verdicts.map((d) => `<li><a href="${esc(d.href)}">${esc(d.label)}</a></li>`).join("")}</ul>`
    : x.linked
      ? "<div>Nijedna presuda za prefikse sa ovog članka.</div>"
      : "<div>Presude iz klaka-api nisu dostupne (nalog portala za UI recenzenta nije podešen).</div>";
  return `<div class="xsum"><strong>Rendgen:</strong> ${esc(c.total)} komentara — javnih ${esc(c.public)},
    u shadow-u ${esc(c.shadow)}, naknadno skinuto ${esc(c.retro)}; ${esc(v.total)} glasova — uračunato
    ${esc(v.public)}, u shadow-u ${esc(v.shadow)}, naknadno skinuto ${esc(v.retro)}.
    <div style="margin-top:6px">Presude za prefikse sa ovog članka (UI recenzenta):</div>${verdicts}</div>`;
}

/** Prijava ili registracija; `next` je stranica na koju se vraća. */
export function accountPage(o: { portal: string; user: User; mode: "prijava" | "registracija"; next: string; error?: string }): string {
  const login = o.mode === "prijava";
  return layout({
    portal: o.portal,
    user: o.user,
    title: login ? "Prijava" : "Registracija",
    body: `<div class="narrow"><h1>${login ? "Prijava" : "Registracija"}</h1>
  ${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
  <form method="post" action="/${o.mode}">
    <input type="hidden" name="next" value="${esc(o.next)}">
    <label>Pseudonim <input name="pseudonym" required minlength="3" maxlength="40" autocomplete="username"></label>
    <label>Lozinka <input name="password" type="password" required minlength="8" autocomplete="${login ? "current-password" : "new-password"}"></label>
    <button type="submit">${login ? "Prijavi se" : "Napravi nalog"}</button>
  </form>
  <p class="meta">${login
    ? `Nemate nalog? <a href="/registracija?next=${encodeURIComponent(o.next)}">Registracija</a>. Komentarisati možete i bez naloga.`
    : `Nalog daje stalan pseudonim (oznaka ✓ uz komentar). Komentarisati možete i bez njega.`}</p></div>`,
  });
}

export function adminPage(o: { portal: string; votes: Vote[]; comments: Comment[] }): string {
  const rows = o.votes
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
  const list = o.comments
    .slice()
    .reverse()
    .map(
      (c) => `<tr>
        <td>${c.token === null ? "" : esc(time(c.t))}</td><td>${esc(c.post)}</td><td>${esc(c.id)}</td>
        <td>${esc(c.author)}</td><td>${esc(c.text.length > 60 ? c.text.slice(0, 60) + "…" : c.text)}</td>
        <td>${esc(c.token ?? "početni")}</td><td class="${c.decision}">${esc(c.decision)}${c.retro ? " (naknadno)" : ""}</td><td>${esc(c.score)}</td></tr>`,
    )
    .join("");
  return layout({
    portal: o.portal,
    user: null,
    title: "Demo admin",
    wide: true,
    body: `<div class="kicker">Samo za demo</div>
<h1>Glasovi</h1>
<table><thead><tr><th>vreme (UTC)</th><th>post</th><th>komentar</th><th>glas</th><th>token</th><th>upotrebe</th><th>ponovljen</th><th>odluka</th><th>vid</th></tr></thead>
<tbody>${rows || `<tr><td colspan="9">Još nema glasova.</td></tr>`}</tbody></table>
<h2>Komentari i javni brojač</h2>
<table><thead><tr><th>vreme (UTC)</th><th>post</th><th>ID</th><th>autor</th><th>tekst</th><th>token</th><th>odluka</th><th>skor</th></tr></thead>
<tbody>${list}</tbody></table>
<p><a href="/">← nazad na portal</a></p>`,
  });
}

function time(t: number): string {
  return new Date(t).toISOString().slice(11, 23);
}

/** „pre 5 min", „pre 3 h", datum — kao ispod komentara na portalu. */
function when(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "upravo";
  if (s < 3600) return `pre ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `pre ${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString("sr-Latn");
}
