# ppd-ts

Senzor u browseru, TypeScript bez runtime zavisnosti (budžet ≤ 8 KB gzip; trenutno < 1 KB).
Vidi `docs/tech_stack.md` §5. **Ne odlučuje ništa i ne zna pragove** — napadač čita ovaj kod.

## Upotreba

```html
<!-- posle učitavanja stranice uzima token sa ppd-api -->
<script src="ppd.min.js" data-api="https://ppd.example.org"
        data-portal="demo.local" data-post="p-1001" async></script>

<!-- obična forma: token se sam upiše u polje ppd_token -->
<form method="post" action="/vote">
  <input type="hidden" name="ppd_token">
  …
</form>

<script>
  // ili fetch: zaglavlje X-PPD-Token
  fetch("/vote", { method: "POST", headers: await ppd.headers(), body })
</script>
```

| API | |
| --- | --- |
| `ppd.init({ api, portal, post, timeoutMs? })` | ručno pokretanje (ako nema `data-*` atributa) |
| `ppd.token()` | `Promise<string \| null>` |
| `ppd.headers()` | `{ "X-PPD-Token": … }` ili `{}` |
| `ppd.fillForms(token, root?)` | za forme dodate posle učitavanja |

Bez tokena (ppd-api nedostupan, tajmaut) stranica radi normalno; akcija kod SDK-a ide u shadow.

## Razvoj

```bash
docker compose run --rm node npm test        # iz korena repoa
docker compose run --rm node npm run build
```

| Gotovo | Sledi |
| --- | --- |
| token pregleda (tajmaut, tihi neuspeh), upis u forme, zaglavlje | događaji `view` / `engage` / `honeypot` (`core/spec/events.md` §2), honeypot elementi, nasumičan DOM, test u pravom browseru (Playwright) |
