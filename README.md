# Klaka

Detekcija koordinisanih napada (glasovi, komentari) na portalima — isključivo iz podataka
koje portal sam može da prikupi. Polazna tačka: [`docs/koncept_detekcija_sa_portala.md`](docs/koncept_detekcija_sa_portala.md);
pojmovi: [`docs/recnik.md`](docs/recnik.md).

## Zašto „Klaka"

**Klaka** (fr. *claque*, od *claquer* — pljeskati) je plaćena publika: ljudi unajmljeni da u
pozorištu ili operi aplaudiraju, smeju se, plaču ili traže bis, da bi ostatak sale poverovao da
je predstava uspeh. Svetonije piše da je Neron imao na hiljade mladića, *Augustijanaca*, koji su
pratili njegove nastupe uvežbanim vrstama aplauza. U Parizu je posle 1820. klaka postala
posao sa agencijama i cenovnicima, i sa podelom uloga: *chef de claque* je vodio akciju,
*rieurs* su se smejali, *pleureuses* plakale, *bisseurs* tražili bis. Operske kuće u Beču i
Milanu imale su klaku i u XX veku; Maler je pokušao da je izbaci iz bečke Dvorske opere.

Klaka nije morala da bude velika. Delovala je zato što publika aplauz drugih čita kao dokaz
da je nešto dobro — isto kao što čitalac danas čita broj glasova i ton komentara ispod
članka. Današnja klaka je koordinisana mreža naloga koja glasa i komentariše po scenariju,
sa istim osobinama kao stara: mala grupa, raspoređena po sali, koja deluje složno i po
uputstvu, u ulogama.

Odatle i pristup ovog projekta: klaka se ne izbacuje iz sale (to bi je samo naučilo da se
bolje sakrije), nego se njen aplauz **ne računa**. Glas koji sistem oceni kao deo koordinisane
akcije čuva se i prikazuje onome ko ga je dao, ali ne ulazi u javni zbir (`shadow`, vidi
[`core/spec/sdk.md`](core/spec/sdk.md)).

Članovi klake su **poslušnici**: glasaju i komentarišu po naređenju, za sitnu korist. Imaju tri
uloge: **pojačivači** guraju (hvale, prave utisak većine), **razvodnjivači** gase vruću temu
gomilom praznih komentara, a **ćaci** ruše — ćaci je zli ljudski bot: toksičan poslušnik,
zlonameran i destruktivan, suprotnost konstruktivnom i društvenom učesniku rasprave. Sve
uloge se definišu ponašanjem, ne stranom, i hvataju se po koordinaciji, ne po sadržaju.
Vidi [`docs/caci.md`](docs/caci.md).

## Pokretanje

Potreban je samo Docker (sa Compose v2).

```bash
docker compose up -d --wait                  # PostgreSQL (+pgvector), Valkey, Ollama + naš sistem
docker compose run --rm rust cargo check     # Rust alati za core/
docker compose run --rm node npm run build   # Node alati za ts/
docker compose run --rm e2e                  # test celog lanca u pravom browseru (Playwright)
docker compose run --rm caci run profiles/rafal-0.json   # emulator klake protiv demo portala
```

Prvo pokretanje preuzima Ollama modele (nekoliko GB). Podešavanja (lozinke, portovi na hostu,
modeli): kopirati `.env.example` u `.env`.

## Struktura

| Folder | Namena |
| --- | --- |
| [`core/`](core/) | naš sistem (Rust) + [`spec/`](core/spec/) protokola + test vektori |
| [`sdk/`](sdk/) | SDK-ovi za backend portala: `node/` (PoC), `php/`, `go/`, `java/` |
| [`ts/`](ts/) | klijentska biblioteka za browser (TypeScript) |
| [`demo/`](demo/) | demo portal (Node, TypeScript): članci, komentari, glasanje — ceo lanac na http://localhost:18082 |
| [`docs/`](docs/) | koncept, tech stack |
| [`caci/`](caci/) | emulator klake: poslušnici protiv demo portala, legitimna publika, izveštaj iz baze |

Svaki folder na nivou namene (ili tehnologije, gde ih ima više) je samostalan i kasnije
postaje zaseban repo. Detalji: [`docs/tech_stack.md`](docs/tech_stack.md) §6.
