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
glasaju (pojačivač, ćaci), ogledalo (strane A i B), čitaoci. Razvodnjivači i nivoi 2–4 slede
(traže komentare u demo-u i Playwright).

Adrese su iz `198.18.0.0/15` (RFC 2544) i stižu do demo-a preko `X-Forwarded-For` — demo mu
veruje **samo u test okruženju**. Dnevnik svakog izvođenja (ground truth) je u `runs/`, van gita.
Profili izvedeni iz stvarnih slučajeva idu u `profiles.local/`, takođe van gita.

| Profil | Šta pokazuje |
| --- | --- |
| `rafal-0.json` | skripta bez tokena: sve u `shadow`, pomeraj 0 |
| `token-1.json` | strpljiv poslušnik sa jednim tokenom, 60 glasova: računa se samo prvi glas po (`vid`, cilj), ostalo `shadow` (`sdk.md` §2a). Pre tog pravila: do `max_uses` uračunatih glasova po tokenu, pomeraj +300/−150 po strani; posle: +12/−3, `shadow` 97–98% |
