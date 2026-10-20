# Presude — v1

Engine zaključuje o **kohortama**; SDK u trenutku akcije zna samo ono što vidi u zahtevu.
Presuda je most: engine je upiše u Valkey pod ključem koji SDK ume da izračuna, SDK je pročita.

## 1. Ključevi

```
ppd:v1:<portal>:net:<prefiks>     npr. ppd:v1:demo.local:net:93.87.12.0/24
ppd:v1:<portal>:vid:<vid>
ppd:v1:<portal>:cid:<cid>         (samo ako portal koristi cid, events.md §3)
```

SDK čita sve ključeve koje ume da izračuna za akciju (jedan `MGET`) i primenjuje
**najstrožu** akciju.

## 2. Vrednost

```json
{"action":"shadow","until_ms":1792003600000,"rev":7}
```

| Polje | Tip | Napomena |
| --- | --- | --- |
| `action` | `"none"` \| `"shadow"` \| `"challenge"` | strogost: `none` < `shadow` < `challenge` |
| `until_ms` | ceo broj | posle ovog trenutka presuda ne važi, čak i ako ključ još postoji |
| `rev` | ceo broj | revizija presude (audit, ne koristi se u odluci) |

Engine postavlja i Valkey TTL ≈ `until_ms`; `until_ms` je merodavan (satovi, kašnjenje brisanja).

**Namerno nema:** razloga, skora, ID-a kohorte, dokaza. Valkey je kod portala i njegov sadržaj
ne treba da otkriva logiku detekcije. Razlozi i dokazi su u `ppd-api` (red za pregled).

Nepoznata `action` → `none`. Neparsabilna vrednost → `none` + SDK beleži grešku.

## 3. `challenge`

Rezervisano za proof-of-work izazov (koncept §10 prethodnog predloga). **U v1 SDK tretira
`challenge` kao `shadow`.**

## 4. Pravila za engine (normativna za `ppd-engine`)

- Presuda po `net` prefiksu MORA biti potkrepljena bihevioralnim ili infrastrukturnim signalom,
  ne samo mrežom: mobilni CGNAT deli /24 sa hiljadama legitimnih korisnika.
- Nijedna presuda zasnovana samo na geografiji ili samo na vremenu (koncept §8).
- Svaka upisana presuda ima zapis u audit-u (`ppd-api`, PostgreSQL) sa dokazima u tom trenutku.
