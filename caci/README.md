# caci — emulator klake

Igra poslušnike klake (pojačivače i ćacije) protiv demo portala, paralelno pušta legitimnu
publiku i meri ishod iz baze događaja. Koncept, uloge i nivoi: [`docs/caci.md`](../docs/caci.md).

```bash
docker compose up -d --wait demo                              # demo + klaka-api + collector + baza
docker compose run --rm caci run profiles/rafal-0.json        # kampanja + izveštaj
docker compose run --rm caci report <run>                     # izveštaj za ranije izvođenje
docker compose run --rm -w /work/caci node npm test            # testovi
```

Ova verzija: nivoi 0 (bez tokena) i 1 (token uzet direktno sa `/v1/view`), uloge koje
glasaju (pojačivač, ćaci), ogledalo (strane A i B), čitaoci i CGNAT blizanac (mnogo čitalaca
iza jednog prefiksa). Čitaoci rade što i pravi browser sa snippetom: šalju `view` i `engage`
collector-u. Razvodnjivači i nivoi 2–4 slede (traže komentare u demo-u i Playwright).

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
