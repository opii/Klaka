# klaka-demo

Portal za proof of concept: naslovna, rubrike (`/r/<rubrika>`), članci (`/p/<post>`), komentari
sa odgovorima, glasanje. Isti komentatori se javljaju na više članaka, kao na pravom portalu.
Node + TypeScript, bez framework-a (`node:http`). Koristi `@klaka/sdk-node` i snippet iz `ts/`.

Stanje je u bazi `portal` (PostgreSQL, ista instanca kao Klaka, ali odvojena baza — portal i
Klaka su razdvojeni kao kod pravog portala): komentari, glasovi, kursor naknadnog shadow-a.
Portal je pravi i migrira pri startu ([`migrations/`](migrations/)). Članci su sadržaj iz repoa:
prva četiri su pisana ručno (na njih ciljaju caci profili, komentari `c1`–`c16`), ostale je jednom
napisao lokalni LLM — neutralne vesti iz izmišljenog grada, sa početnim komentarima i odgovorima
([`scripts/write-articles.mjs`](scripts/write-articles.mjs) → `content/articles.json`):

```bash
docker compose run --rm --no-deps -w /work/demo node node scripts/write-articles.mjs   # ~4 min po članku na CPU-u
```

Komentari: niti (odgovor ostaje uz roditelja), poređani po zbiru („Najbolji", podrazumevano) ili
po vremenu, 50 niti po stranici. Trajni link na komentar, `/p/<post>?komentar=<id>`, otvara
stranicu na kojoj je — tako i caci i e2e dolaze do ciljanog komentara kad ih na članku ima
hiljade. Zbir je onaj koji vidi posetilac, pa poslušnik vidi svoj gurnut komentar na vrhu.

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
nalog ili sesiju); za ostale ne postoji — ni na stranici, ni u `/api/comments`, ni za glas, ni
kao roditelj odgovora.

Naknadni shadow (`verdicts.md` §5): svake 2 s demo čita `Klaka.retro` i akcije koje je engine
uz presudu poslao prebacuje u shadow — komentar nestaje iz javnog prikaza (autoru ostaje), glas
se oduzima od brojača. U `/admin` su označene sa „(naknadno)". U compose-u demo veruje zaglavlju
`X-Forwarded-For` — **samo za test okruženje**, da bi emulator klake (`caci/`) mogao da dodeli
adrese.

**Samo za demo:** `/admin`, `/admin/votes.json` i `/admin/comments.json` (poslednjih 1000, ili
`?id=` za jedan komentar) prikazuju razloge odluka; `POST /admin/promote {"post","channel"}` glumi da je portal poslao push (događaj
`promotion`, za legitimnog blizanca u emulatoru). Pravi portal ih nikad ne izlaže. Presude u Valkey upisuje `klaka-engine`.
