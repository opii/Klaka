# Klaka

Detekcija koordinisanih napada (glasovi, komentari) na portalima — isključivo iz podataka
koje portal sam može da prikupi. Polazna tačka: [`docs/koncept_detekcija_sa_portala.md`](docs/koncept_detekcija_sa_portala.md).

## Pokretanje

Potreban je samo Docker (sa Compose v2).

```bash
docker compose up -d --wait                  # PostgreSQL (+pgvector), Valkey, Ollama + naš sistem
docker compose run --rm rust cargo check     # Rust alati za core/
docker compose run --rm node npm run build   # Node alati za ts/
docker compose run --rm e2e                  # test celog lanca u pravom browseru (Playwright)
```

Prvo pokretanje preuzima Ollama modele (nekoliko GB). Podešavanja (lozinke, portovi na hostu,
modeli): kopirati `.env.example` u `.env`.

## Struktura

| Folder | Namena |
| --- | --- |
| [`core/`](core/) | naš sistem (Rust) + [`spec/`](core/spec/) protokola + test vektori |
| [`sdk/`](sdk/) | SDK-ovi za backend portala: `node/` (PoC), `php/`, `go/`, `java/` |
| [`ts/`](ts/) | klijentska biblioteka za browser (TypeScript) |
| [`demo/`](demo/) | demo portal (Node, TypeScript): članak, komentari, glasanje — ceo lanac na http://localhost:18082 |
| [`docs/`](docs/) | koncept, tech stack |

Svaki folder na nivou namene (ili tehnologije, gde ih ima više) je samostalan i kasnije
postaje zaseban repo. Detalji: [`docs/tech_stack.md`](docs/tech_stack.md) §6.
