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
docker compose run --rm e2e           # 10 testova u pravom browseru (Chromium)
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

Nalog je opcion, kao na većini portala u regionu: komentar i glas i bez njega (pseudonim uz
komentar), a nalog (`/registracija`, `/prijava`, `/odjava`) daje stalan pseudonim sa oznakom ✓ i
`cid` (`sdk.md` §4: `cidOf(PORTAL_CID_SALT, nalog)`), pa engine vidi istog posetioca kroz postove.
Registrovan pseudonim anonimni komentator ne može da koristi. Lozinke: `scrypt` sa solju po
nalogu; prijava menja kolačić sesije (zaštita od fiksiranja), a anonimne akcije sa uređaja prelaze
na novi kolačić.

Pogledi na komentare (`?pogled=`, prekidač iznad komentara; `PORTAL_XRAY=isključen` ih gasi —
na javnom serveru otkrivaju presude napadaču):

| Pogled | Šta pokazuje |
| --- | --- |
| Javno | ono što vidi svako: javni zbir, javni komentari i svoji shadow |
| Pogled poslušnika | portal kakav klaka misli da je kupila: i tuđi shadow komentari, zbir sa svim shadow glasovima (svaki poslušnik inače vidi samo svoje) |
| Rendgen | šta je Klaka prepoznala: stanje svakog komentara (u shadow-u i zašto, naknadno skinut), javni zbir naspram glasova u shadow-u i naknadno skinutih, glasovi iz prefiksa sa presudom, presude i uloge kohorti — sa linkovima na UI recenzenta (:18083) |

Rendgen presude čita iz `klaka-api` (`/api/presude` na listener-u recenzenta), pod nalogom
portala (`PORTAL_REVIEW_AUTH=ime:token`, isti par kao jedan unos u `KLAKA_REVIEW_TOKENS`); bez
njega pokazuje samo ono što portal sam zna. Prikazuje samo presude nastale posle prve akcije
prefiksa na članku (uz prozor naknadnog shadow-a) — starija je o nekom ranijem korisniku istog
prefiksa. Portal zato uz svaku akciju pamti prefiks (/24, /48), nikad pun IP. U obrnutom smeru,
presuda u UI-ju recenzenta vodi na komentar u portalu, u Rendgenu (`KLAKA_PORTAL_LINKS`). Tuđ
shadow komentar je u ovim pogledima bez glasanja i bez `data-klaka-comment`, da posetilac
Rendgena ne puni `seen` komentarima koje inače ne vidi.

`shadow` komentar vidi samo njegov autor — sa istog uređaja (kolačić `demo_sid`) ili, prijavljen,
sa svog naloga; za ostale ne postoji — ni na stranici, ni u `/api/comments`, ni za glas, ni kao
roditelj odgovora.

Naknadni shadow (`verdicts.md` §5): svake 2 s demo čita `Klaka.retro` i akcije koje je engine
uz presudu poslao prebacuje u shadow — komentar nestaje iz javnog prikaza (autoru ostaje), glas
se oduzima od brojača. U `/admin` su označene sa „(naknadno)". U compose-u demo veruje zaglavlju
`X-Forwarded-For` — **samo za test okruženje**, da bi emulator klake (`caci/`) mogao da dodeli
adrese.

**Samo za demo:** `/admin`, `/admin/votes.json` i `/admin/comments.json` (poslednjih 1000, ili
`?id=` za jedan komentar) prikazuju razloge odluka; `POST /admin/promote {"post","channel"}` glumi da je portal poslao push (događaj
`promotion`, za legitimnog blizanca u emulatoru). Pravi portal ih nikad ne izlaže. Presude u Valkey upisuje `klaka-engine`.
