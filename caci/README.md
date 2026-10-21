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
`reaction_ms` pušta poslušnike u talasu posle „naređenja" umesto ravnomerno. Blizanac
`audience.push`: emulator kroz demo javi da je portal poslao push (`POST /admin/promote`, događaj
`promotion`), a isti verni čitaoci stižu za par sekundi i glasaju za najbolji komentar, na više
postova. Engine glasove u prozoru promocije (10 min) ne broji kao usklađene — zato između dva
izvođenja sa push-om treba 10 minuta, inače prvo „opravda" glasove drugog na istim postovima.

Adrese su iz `198.18.0.0/15` (RFC 2544) i stižu do demo-a, `klaka-api`-ja i collector-a preko
`X-Forwarded-For` — oni mu veruju **samo u test okruženju**. Prefiksi sa važećom presudom i
oni korišćeni u poslednjih 15 minuta se preskaču (naknadni shadow kohorte bi inače skinuo i
akcije čitaoca iz prethodnog izvođenja sa istog prefiksa); ako presuda ipak pogodi izvođenje,
izveštaj je prikazuje kao „pre početka". Dnevnik svakog izvođenja (ground truth) je u `runs/`, van gita. Profili izvedeni iz
stvarnih slučajeva idu u `profiles.local/`, takođe van gita.

Izveštaj: po grupi `shadow` u trenutku akcije i `naknadno` (skinuto posle presude, iz audita
`verdict_retro`; demo ga primenjuje u roku od 2 s), za poslušnike odziv, za čitaoce lažni
pozitivi; pomeraj javnog zbira posle naknadnog shadow-a i rezultati tokena; isto za komentare, uz udeo klake u javnim komentarima članaka na
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
| `pazljiv-3-postovi.json` | isti nivo 3, ali gura i potiskuje iste autore kroz 3 posta. Detektor usmerenih glasova: presude na sva 4 prefiksa kohorte za 14–19 s, `shadow` 78–83%, pomeraj +11..13/−5..6 po strani (bez njega +60/−30); čitaoci i CGNAT bez presude. (Sa organskim udelom iz svih prefiksa umesto iz pojedinaca: 19–26 s, 67–75% — koordinisani prefiksi su dizali meru jedni drugima.). **Sa naknadnim shadow-om** (`verdicts.md` §5) pomeraj pada na −1..+1 po strani: 22–30% glasova kohorte je skinuto posle presude |
| `razvodnjivaci-2.json` | razvodnjivači, nivo 2: zatrpavaju jedan članak nalepljenim praznim komentarima i glasaju jedni za druge. Detektor nenapisanih komentara (`compose` bez tastera): presude na sva 4 prefiksa za 16–26 s; komentari 22–39% `shadow` — ostali su napisani pre presude, pa je udeo klake u javnim komentarima članka i dalje 86% (bez detektora 94%). Deljeni šabloni ne presuđuju: sve je na jednom članku. Publika i CGNAT bez presude. **Sa naknadnim shadow-om** skinuto je i 61% komentara napisanih pre presude: udeo klake u javnim komentarima članka pada na 17% (1 od 6) |
| `smena-4.json` | nivo 4: sve tri uloge, dve smene iz istih prefiksa, rotacija 3 pseudonima, parafraze šablona (32/32, `gemma3:4b`). Usmereni glasovi: presude za 42–48 s (smena ima pola poslušnika, pa se kohorta sporije skuplja), posle toga i druga smena u `shadow`: glasovi 50–58% na obe strane, pomeraj +10..11/−5..6 umesto +24/−12; komentari klake 50–75% `shadow` (preko presude prefiksu); čitaoci i CGNAT bez presude. Parafraze sa 8 komentara po prefiksu: 4–5 šablonskih, sami deljeni šabloni bi presudili za 2 od 4 prefiksa. **Sa naknadnim shadow-om**: pomeraj 0 na obe strane (38–42% glasova kohorte skinuto posle presude), nijedan komentar klake javan ni na jednom članku; čitaoci i CGNAT bez ijedne naknadno skinute akcije |
| `sabloni-3.json` / `sabloni-4.json` | samo komentari, kucani (nivo 3–4, bez glasova): isti šabloni kroz 3 članka, odnosno parafraze uz 3 pseudonima. Prolaze sve detektore glasova i nenapisanih komentara; hvata ih samo tekst — deljeni šabloni: presude na sva 4 prefiksa za 25 s (kopije), odnosno 29–34 s (parafraze); komentari 44–63%, odnosno 38–50% `shadow`; čitaoci (komentare im piše LLM) i CGNAT bez presude. **Sa naknadnim shadow-om** (`sabloni-3`) nijedan komentar klake ne ostaje javan, ni na jednom od 3 članka. **Sa blizancem samo sa drugog posta** (kNN 7 dana unazad): bez tog pravila čitaoci su nalazili blizance u ranijim izvođenjima na istom članku, organski udeo je porastao na 0,28 i `sabloni-4` je propustio jedan prefiks (10/12 šablonskih, lift 2,98); sa njim organski udeo 0,01–0,10, presude na sva 4 prefiksa za 26–31 s (kopije), odnosno 30 s (parafraze), lift 9–80. Posle naknadnog shadow-a javan je ostao 1 komentar klake od 48 (`sabloni-3`), 0 od 48 (`sabloni-4`) — taj jedan je server prihvatio 45 ms pre presude, a u bazu je stigao posle nje, pa ga nije obuhvatio ni shadow ni naknadni shadow |
| `rasuta-3.json` | nivo 3, klaka rasuta po prefiksima: svaki poslušnik svoj prefiks i 3 glasa (jedan po članku), talas ~20 s posle „naređenja" — ispod svih pragova po prefiksu; uz to push blizanac (verni čitaoci posle push-a na 2 članka). Bez usklađenih glasova: **nijedna presuda**, pomeraj +24/−18 po strani. Sa njima: presude na svih 16 prefiksa kohorte za 35–65 s, posle naknadnog shadow-a pomeraj −1..+1; čitaoci, CGNAT i push blizanac bez presude (blizanac je vremenski i ciljno usklađen kao klaka — razlikuje ga samo događaj `promotion`) |
| `rasuti-sabloni-3.json` | nivo 3, komentari rasuti po prefiksima: 8 pojačivača po strani, svaki svoj prefiks i 3 kucana šablona (jedan po članku) — ispod `min_comments`, pa ih deljeni šabloni po prefiksu ne vide, a kao „pojedinci" dižu organski udeo. Bez usklađenih šablona: **nijedna presuda**, klaka drži 57–84% javnih komentara po članku; pušten uporedo sa `sabloni-3`, ni `sabloni-3` nema nijednu presudu (73–90%) — rasuta klaka štiti i koncentrisanu. Sa grafom usklađenih šablona (klasteri kopija i parafraza, ≥ 2 zajednička šablona na ≥ 2 posta, članovi van organskog udela): presude na svih 16 prefiksa za 30–35 s, nijedan komentar klake javan; uporedo sa `sabloni-3` i njegova 4 prefiksa za 11–21 s. Čitaoci i CGNAT bez presude (osim čitaoca drugog izvođenja na istom prefiksu kad se dva emulatora puste uporedo — kolateral iz `verdicts.md` §5) |
| `rasuti-sabloni-4.json` | isto kao `rasuti-sabloni-3`, ali nivo 4: parafraze (`gemma3:4b`) uz 3 pseudonima. Šum malog modela je glavna granica: deo parafraza ispadne tik iznad praga (0,215–0,283), pa prefiks sa 3 komentara ostane sa jednim pogođenim šablonom. Sa grafom preko komponenti povezanosti 15/16 (parafraza pomerena ka drugom šablonu iste uloge spaja dva šablona u jedan); sa „dva koraka" i kNN-om u prozoru, prag 0,2: 14, 16 i 11 od 16 (33–48 s); sa pragom grafa 0,25 (`KLAKA_ENGINE_MAX_GRAPH_DISTANCE`): **16 od 16 u sva 3 izvođenja** (25–45 s), nijedan komentar klake javan. Čitaoci i CGNAT bez presude; ni na 0,28 nijedan čitalac ni CGNAT bez ivice u grafu (simulacija nad 7 izvođenja) |
| `uloge-3.json` / `uloge-4.json` | provera uloge kohorte na podacima koje pravila nisu videla: novi tekstovi šablona za sve tri uloge, svaka uloga na svojim prefiksima (`separate_roles`), razvodnjivači na dva članka; nivo 3 kucano, nivo 4 parafraze uz 3 pseudonima. Presude na svih 12 prefiksa u oba (usmereni glasovi za pojačivače i ćacije, deljeni šabloni za razvodnjivače), nijedan komentar klake javan. Uloga: tačan skup 16/24 — ćaci 8/8, pojačivač 8/8 uz 5 lažnih, razvodnjivač 2/8 (`docs/caci.md` §1) |

Pokretati sa `--no-deps` posle build-a slike `klaka-core`: inače `docker compose run` ponovo
podigne `klaka-api` sa novim (privremenim) ključem, a demo ga preuzme tek posle do 15 s —
glasovi u tom razmaku dobiju `bad_signature`.
