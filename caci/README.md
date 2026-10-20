# caci — emulator klake

Igra poslušnike klake (pojačivače i ćacije) protiv demo portala, paralelno pušta legitimnu
publiku i meri ishod iz baze događaja. Koncept, uloge i nivoi: [`docs/caci.md`](../docs/caci.md).

```bash
docker compose up -d --wait demo                              # demo + klaka-api + collector + baza
docker compose run --rm caci run profiles/rafal-0.json        # kampanja + izveštaj
docker compose run --rm caci report <run>                     # izveštaj za ranije izvođenje
docker compose run --rm -w /work/caci node npm test            # testovi
```

Ova verzija: nivoi 0 (bez tokena), 1 (token uzet direktno sa `/v1/view`) i 2–3 (pravi
Chromium preko Playwright-a), uloge koje glasaju (pojačivač, ćaci), ogledalo (strane A i B),
čitaoci i CGNAT blizanac (mnogo čitalaca iza jednog prefiksa). Čitaoci rade što i pravi
browser sa snippetom: pročitaju 1–3 članka i za svaki šalju `view` i `engage` collector-u.
Ciljevi (`targets`) su ID-jevi komentara, sa bilo kog članka; emulator sam nalazi članak.
Razvodnjivači i nivo 4 slede.

Adrese su iz `198.18.0.0/15` (RFC 2544) i stižu do demo-a, `klaka-api`-ja i collector-a preko
`X-Forwarded-For` — oni mu veruju **samo u test okruženju**. Prefiksi sa važećom presudom iz
ranijih izvođenja se preskaču; ako ipak pogode izvođenje, izveštaj ih prikazuje kao „pre
početka". Dnevnik svakog izvođenja (ground truth) je u `runs/`, van gita. Profili izvedeni iz
stvarnih slučajeva idu u `profiles.local/`, takođe van gita.

Izveštaj: po grupi `shadow` (za poslušnike odziv, za čitaoce lažni pozitivi), pomeraj javnog
zbira i rezultati tokena; zatim presude engine-a — kada su nastale i koga su pogodile.

| Profil | Šta pokazuje |
| --- | --- |
| `rafal-0.json` | skripta bez tokena: sve u `shadow`, pomeraj 0 |
| `token-1.json` | strpljiv poslušnik sa jednim tokenom, 60 glasova: računa se samo prvi glas po (`vid`, cilj), ostalo `shadow` (`sdk.md` §2a). Pre tog pravila: do `max_uses` uračunatih glasova po tokenu, pomeraj +300/−150 po strani; posle: +12/−3, `shadow` 97–98% |
| `svez-token-1.json` | nov prikaz za svaki glas: token ispravan, glas nije ponovljen. Bez engine-a **0% `shadow`**, pomeraj +120/−60 po strani. Sa engine-om (detektor prikaza-duhova): presude na sva 4 prefiksa kohorte posle ~11 s, `shadow` 82–85%, pomeraj +19..22/−9..10; čitaoci i CGNAT blizanac 0% |
| `browser-2.json` | nivo 2: pravi Chromium, svaki glas novo učitavanje stranice (pravi `view`/`engage`), glas iz konzole. Prolazi detektor duhova; detektor nečitanih glasova ga hvata (nema unosa): presude za 14–19 s, `shadow` 70–77%; čitaoci i CGNAT 0% |
| `browser-2-klik.json` | nivo 2 sa klikom i sakrivenim `webdriver`-om: klik daje unos, ali komentar nije bio u `seen` (Playwright skroluje i odmah klikne): presude za 12–22 s, `shadow` 53–77%; čitaoci i CGNAT 0% |
| `pazljiv-3.json` | nivo 3: skroluje do komentara, zadrži se, pa klikne — **nije uhvaćen** (0%). Granica signala čitanja: ostaju ponavljanje kohorte kroz postove, ritam i iste mete |

Pokretati sa `--no-deps` posle build-a slike `klaka-core`: inače `docker compose run` ponovo
podigne `klaka-api` sa novim (privremenim) ključem, a demo ga preuzme tek posle do 15 s —
glasovi u tom razmaku dobiju `bad_signature`.
