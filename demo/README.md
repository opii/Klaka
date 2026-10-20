# klaka-demo

Demo portal za proof of concept: četiri članka (`/p/<post>`), komentari, glasanje. Isti
komentatori se javljaju na više članaka, kao na pravom portalu. Node + TypeScript, bez
framework-a (`node:http`). Koristi `@klaka/sdk-node` i snippet iz `ts/`.

```bash
docker compose up -d --build demo     # http://localhost:18082  (+ /admin)
docker compose run --rm e2e           # 8 testova u pravom browseru (Chromium)
```

| Šta pokazuje | Ishod |
| --- | --- |
| čitalac glasa posle čitanja | `valid` → `count`, javni brojač +1 |
| glas odmah posle učitavanja | `too_young` → shadow; glasaču izgleda isto, i posle osvežavanja (vidi zbir sa svojim glasom, ostali javni) |
| bot bez tokena (direktan POST) | `missing` → shadow, isti odgovor `{"ok":true}` |
| lažan token | `bad_signature` → shadow, isti odgovor |
| token drugog posta | `wrong_post` → shadow |
| isti prikaz ponovo glasa za isti komentar | `repeat` → shadow (`sdk.md` §2a) |
| komentar posle čitanja | `valid` → `count`, vide ga svi; snippet šalje `compose` |
| komentar odmah posle učitavanja | `too_young` → shadow: autor ga vidi, ostali ne |

Glas obrađuje `Klaka.onVote`, a komentar `Klaka.onComment` iz `@klaka/sdk-node`, sa Valkey-jem
(brojač upotreba, ponovljeni glasovi, presude) preko adaptera [`src/valkey.ts`](src/valkey.ts).
Svaki glas i komentar ide i u `klaka-collector` kao `vote` / `comment` događaj (sa prefiksom
mreže, ne punim IP-jem); pri startu demo javlja `post` za svaki članak, sa tekstom.

`shadow` komentar vidi samo njegov autor, prepoznat po kolačiću `demo_sid` (pravi portal ima
nalog ili sesiju); za ostale ne postoji — ni na stranici, ni u `/api/comments`, ni za glas.

Naknadni shadow (`verdicts.md` §5): svake 2 s demo čita `Klaka.retro` i akcije koje je engine
uz presudu poslao prebacuje u shadow — komentar nestaje iz javnog prikaza (autoru ostaje), glas
se oduzima od brojača. U `/admin` su označene sa „(naknadno)". U compose-u demo veruje zaglavlju `X-Forwarded-For` — **samo za test
okruženje**, da bi emulator klake (`caci/`) mogao da dodeli adrese.

**Samo za demo:** `/admin`, `/admin/votes.json` i `/admin/comments.json` prikazuju razloge
odluka; `POST /admin/promote {"post","channel"}` glumi da je portal poslao push (događaj
`promotion`, za legitimnog blizanca u emulatoru). Pravi portal ih nikad ne izlaže. Presude u Valkey upisuje `klaka-engine`.
