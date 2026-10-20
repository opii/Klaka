# klaka-ts

Senzor u browseru, TypeScript bez runtime zavisnosti (budžet ≤ 8 KB gzip; trenutno ~3 KB).
Vidi `docs/tech_stack.md` §5. **Ne odlučuje ništa i ne zna pragove** — napadač čita ovaj kod.

## Upotreba

```html
<!-- posle učitavanja stranice uzima token sa klaka-api; sa data-collector šalje i događaje -->
<script src="klaka.min.js" data-api="https://klaka.example.org"
        data-collector="https://collector.example.org"
        data-portal="demo.local" data-post="p-1001" async></script>

<!-- komentari: ID isti kao `target` u glasu (za `seen`) -->
<div data-klaka-comment="c-1">…</div>

<!-- obična forma: token se sam upiše u polje klaka_token; polje za tekst meri `compose` -->
<form method="post" action="/comment">
  <input type="hidden" name="klaka_token">
  <textarea name="text" data-klaka-compose></textarea>
</form>

<script>
  // ili fetch: zaglavlje X-Klaka-Token
  fetch("/vote", { method: "POST", headers: await klaka.headers(), body })
</script>
```

| API | |
| --- | --- |
| `klaka.init({ api, collector?, portal, post, timeoutMs? })` | ručno pokretanje (ako nema `data-*` atributa) |
| `klaka.token()` | `Promise<string \| null>` |
| `klaka.headers()` | `{ "X-Klaka-Token": … }` ili `{}` |
| `klaka.fillForms(token, root?)` | za forme dodate posle učitavanja |
| `klaka.flush()` | pošalji sažetak čitanja odmah (SPA navigacija) |
| `klaka.composed(el)` | komentar iz `data-klaka-compose` polja poslat fetch-om |

Bez tokena (klaka-api nedostupan, tajmaut) stranica radi normalno; akcija kod SDK-a ide u shadow.

**Događaji** (`core/spec/events.md` §2), preko `sendBeacon` kao `text/plain`:

| Događaj | Kada | Šta |
| --- | --- | --- |
| `view` | odmah posle tokena | referer (origin + putanja), jezik, vremenska zona, viewport na 100 px, `navigator.webdriver` |
| `engage` | skrivanje taba, `pagehide`, na 30 s | vreme, vidljivo vreme, dubina i histogram skrolovanja, skokovi, broj unosa po vrsti, kad su komentari prvi put viđeni, `seen` (≥ 50% vidljivo bar 500 ms) |
| `compose` | slanje forme | samo opsezi: tasteri, nalepljeno, dužina — bez teksta i bez vremena između tastera |

## Razvoj

```bash
docker compose run --rm node npm test        # iz korena repoa
docker compose run --rm node npm run build
docker compose run --rm e2e                  # u pravom browseru, kroz demo portal
```

| Gotovo | Sledi |
| --- | --- |
| token pregleda, upis u forme, zaglavlje; `view`, `engage` (+`seen`), `compose` | `honeypot` elementi, nasumičan DOM, canary parametar (`variant`) |
