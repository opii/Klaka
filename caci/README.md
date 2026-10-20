# caci — emulator klake

Igra poslušnike klake (pojačivače, ćacije i razvodnjivače) protiv demo portala, paralelno
pušta legitimnu publiku i meri ishod iz baze događaja. Koncept, uloge i nivoi: [`docs/caci.md`](../docs/caci.md).

```bash
docker compose up -d --wait demo                              # demo + klaka-api + collector + baza
docker compose run --rm caci run profiles/rafal-0.json        # kampanja + izveštaj
docker compose run --rm caci report <run>                     # izveštaj za ranije izvođenje
docker compose run --rm -w /work/caci node npm test            # testovi
```

Ova verzija: nivoi 0 (bez tokena), 1 (token uzet direktno sa `/v1/view`) i 2–4 (pravi
Chromium preko Playwright-a), sve tri uloge sa glasovima i komentarima, ogledalo (strane A i
B), čitaoci i CGNAT blizanac (mnogo čitalaca iza jednog prefiksa). Čitaoci rade što i pravi
browser sa snippetom: pročitaju 1–3 članka i za svaki šalju `view` i `engage` (a uz komentar
i `compose`) collector-u. Ciljevi (`targets`) su ID-jevi komentara, sa bilo kog članka;
emulator sam nalazi članak. Komentar u browseru ide kroz formu: nivo 2 ga nalepi, nivoi 3–4
ga kucaju. Nivo 4: smene, rotacija pseudonima i parafraze šablona preko lokalnog Ollama
servisa (`docker compose up -d --wait ollama ollama-pull`, model `KLAKA_LLM_MODEL`).

Adrese su iz `198.18.0.0/15` (RFC 2544) i stižu do demo-a, `klaka-api`-ja i collector-a preko
`X-Forwarded-For` — oni mu veruju **samo u test okruženju**. Prefiksi sa važećom presudom iz
ranijih izvođenja se preskaču; ako ipak pogode izvođenje, izveštaj ih prikazuje kao „pre
početka". Dnevnik svakog izvođenja (ground truth) je u `runs/`, van gita. Profili izvedeni iz
stvarnih slučajeva idu u `profiles.local/`, takođe van gita.

Izveštaj: po grupi `shadow` (za poslušnike odziv, za čitaoce lažni pozitivi), pomeraj javnog
zbira i rezultati tokena; isto za komentare, uz udeo klake u javnim komentarima članaka na
kojima je pisala (merilo za razvodnjivače); zatim presude engine-a — kada su nastale i koga su
pogodile.

| Profil | Šta pokazuje |
| --- | --- |
| `rafal-0.json` | skripta bez tokena: sve u `shadow`, pomeraj 0 |
| `token-1.json` | strpljiv poslušnik sa jednim tokenom, 60 glasova: računa se samo prvi glas po (`vid`, cilj), ostalo `shadow` (`sdk.md` §2a). Pre tog pravila: do `max_uses` uračunatih glasova po tokenu, pomeraj +300/−150 po strani; posle: +12/−3, `shadow` 97–98% |
| `svez-token-1.json` | nov prikaz za svaki glas: token ispravan, glas nije ponovljen. Bez engine-a **0% `shadow`**, pomeraj +120/−60 po strani. Sa engine-om (detektor prikaza-duhova): presude na sva 4 prefiksa kohorte posle ~11 s, `shadow` 82–85%, pomeraj +19..22/−9..10; čitaoci i CGNAT blizanac 0% |
| `browser-2.json` | nivo 2: pravi Chromium, svaki glas novo učitavanje stranice (pravi `view`/`engage`), glas iz konzole. Prolazi detektor duhova; detektor nečitanih glasova ga hvata (nema unosa): presude za 14–19 s, `shadow` 70–77%; čitaoci i CGNAT 0% |
| `browser-2-klik.json` | nivo 2 sa klikom i sakrivenim `webdriver`-om: klik daje unos, ali komentar nije bio u `seen` (Playwright skroluje i odmah klikne): presude za 12–22 s, `shadow` 53–77%; čitaoci i CGNAT 0% |
| `pazljiv-3.json` | nivo 3: skroluje do komentara, zadrži se, pa klikne — **nije uhvaćen** (0%). Granica signala čitanja; kampanja je na jednom postu, a pravilo preseka traži više |
| `pazljiv-3-postovi.json` | isti nivo 3, ali gura i potiskuje iste autore kroz 3 posta. Detektor usmerenih glasova: presude na sva 4 prefiksa kohorte za 14–19 s, `shadow` 78–83%, pomeraj +11..13/−5..6 po strani (bez njega +60/−30); čitaoci i CGNAT bez presude. (Sa organskim udelom iz svih prefiksa umesto iz pojedinaca: 19–26 s, 67–75% — koordinisani prefiksi su dizali meru jedni drugima.) |
| `razvodnjivaci-2.json` | razvodnjivači, nivo 2: zatrpavaju jedan članak nalepljenim praznim komentarima i glasaju jedni za druge. Detektor nenapisanih komentara (`compose` bez tastera): presude na sva 4 prefiksa za 16–26 s; komentari 22–39% `shadow` — ostali su napisani pre presude, pa je udeo klake u javnim komentarima članka i dalje 86% (bez detektora 94%). Deljeni šabloni ne presuđuju: sve je na jednom članku. Publika i CGNAT bez presude |
| `smena-4.json` | nivo 4: sve tri uloge, dve smene iz istih prefiksa, rotacija 3 pseudonima, parafraze šablona (32/32, `gemma3:4b`). Usmereni glasovi: presude za 42–48 s (smena ima pola poslušnika, pa se kohorta sporije skuplja), posle toga i druga smena u `shadow`: glasovi 50–58% na obe strane, pomeraj +10..11/−5..6 umesto +24/−12; komentari klake 50–75% `shadow` (preko presude prefiksu); čitaoci i CGNAT bez presude. Parafraze sa 8 komentara po prefiksu: 4–5 šablonskih, sami deljeni šabloni bi presudili za 2 od 4 prefiksa |
| `sabloni-3.json` / `sabloni-4.json` | samo komentari, kucani (nivo 3–4, bez glasova): isti šabloni kroz 3 članka, odnosno parafraze uz 3 pseudonima. Prolaze sve detektore glasova i nenapisanih komentara; hvata ih samo tekst — deljeni šabloni: presude na sva 4 prefiksa za 25 s (kopije), odnosno 29–34 s (parafraze); komentari 44–63%, odnosno 38–50% `shadow`; čitaoci (komentare im piše LLM) i CGNAT bez presude |

Pokretati sa `--no-deps` posle build-a slike `klaka-core`: inače `docker compose run` ponovo
podigne `klaka-api` sa novim (privremenim) ključem, a demo ga preuzme tek posle do 15 s —
glasovi u tom razmaku dobiju `bad_signature`.
