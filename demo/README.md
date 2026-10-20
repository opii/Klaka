# klaka-demo

Demo portal za proof of concept: jedan članak, komentari, glasanje. Node + TypeScript, bez
framework-a (`node:http`). Koristi `@klaka/sdk-node` i snippet iz `ts/`.

```bash
docker compose up -d --build demo     # http://localhost:18082  (+ /admin)
docker compose run --rm e2e           # 5 testova u pravom browseru (Chromium)
```

| Šta pokazuje | Ishod |
| --- | --- |
| čitalac glasa posle čitanja | `valid` → `count`, javni brojač +1 |
| glas odmah posle učitavanja | `too_young` → shadow; glasaču izgleda isto |
| bot bez tokena (direktan POST) | `missing` → shadow, isti odgovor `{"ok":true}` |
| lažan token | `bad_signature` → shadow, isti odgovor |
| token drugog posta | `wrong_post` → shadow |

Svaki glas ide i u `klaka-collector` kao `vote` događaj (sa prefiksom mreže, ne punim IP-jem),
u pozadini preko `EventSender`-a iz `@klaka/sdk-node`; pri startu demo javlja i `post`.
U compose-u demo veruje zaglavlju `X-Forwarded-For` — **samo za test okruženje**, da bi emulator
klake (`caci/`) mogao da dodeli adrese.

**Samo za demo:** `/admin` i `/admin/votes.json` prikazuju razloge odluka. Pravi portal ih
nikad ne izlaže. Brojač upotreba je u memoriji (po spec-u ide u Valkey), presude iz Valkey-ja
još ne postoje (akcija je uvek `none`).
