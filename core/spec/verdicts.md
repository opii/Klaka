# Presude — v1

Engine zaključuje o **kohortama**; SDK u trenutku akcije zna samo ono što vidi u zahtevu.
Presuda je most: engine je upiše u Valkey pod ključem koji SDK ume da izračuna, SDK je pročita.

## 1. Ključevi

```
klaka:v1:<portal>:net:<prefiks>     npr. klaka:v1:demo.local:net:93.87.12.0/24
klaka:v1:<portal>:vid:<vid>
klaka:v1:<portal>:cid:<cid>         (samo ako portal koristi cid, events.md §3)
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
ne treba da otkriva logiku detekcije. Razlozi i dokazi su u `klaka-api` (red za pregled).

Nepoznata `action` → `none`. Neparsabilna vrednost → `none` + SDK beleži grešku.

## 3. `challenge`

Rezervisano za proof-of-work izazov. **U v1 SDK tretira
`challenge` kao `shadow`.**

## 4. Pravila za engine (normativna za `klaka-engine`)

- Presuda po `net` prefiksu MORA biti potkrepljena još bar jednom nezavisnom dimenzijom, ne
  samo mrežom: mobilni CGNAT deli /24 sa hiljadama legitimnih korisnika. Dovoljan je
  bihevioralni ili infrastrukturni signal; ciljni (iste mete) ili tekstualni (ista formulacija)
  samo ako se ponavlja na više postova i odstupa od organske publike (koncept §2a, pravilo
  preseka).
- Nijedna presuda zasnovana samo na geografiji ili samo na vremenu (koncept §8).
- Svaka upisana presuda ima zapis u audit-u (`klaka-api`, PostgreSQL) sa dokazima u tom trenutku.
- Uz svaku presudu `shadow` engine upisuje i naknadni shadow (§5) za prozor u kome je video
  dokaze — u istoj transakciji audita: nema unosa u stream bez zapisa, ni obrnuto.

## 5. Naknadni shadow

Presuda važi za akcije **posle** nje. Ono što je kohorta uradila dok se nije skupila — u prozoru
u kome je engine video dokaze — ostalo bi uračunato: kod komentara je to najveći deo štete
(razvodnjivač zatrpa temu pre nego što ga detektor prepozna). Zato engine uz presudu javlja i
spisak tih akcija, a portal ih naknadno prebacuje u shadow.

**Ključ:** Valkey stream `klaka:v1:<portal>:retro`. Jedan unos = jedna akcija koja je u trenutku
akcije dobila `count`:

| Polje | Vrednost |
| --- | --- |
| `kind` | `"comment"` \| `"vote"` |
| `post` | post akcije |
| `comment` | samo za `comment`: ID komentara u sistemu portala |
| `vid`, `target` | samo za `vote`: prikaz i komentar na koji je glasano. Prikaz ima najviše jedan uračunat glas po cilju (`sdk.md` §2a), pa par jednoznačno određuje glas |

Engine upisuje sve takve akcije iz prefiksa presude u prozoru dokaza i seče stream na 24 sata
(`XADD … MINID ~`). Portal čita unose posle poslednjeg obrađenog ID-ja (`sdk.md` §2b) i za svaki:

- **komentar** — više se ne prikazuje javno; autor ga i dalje vidi kao svoj (princip 3);
- **glas** — oduzima se od javnog zbira; glasaču se ništa ne javlja.

Obrada MORA biti idempotentna: isti unos može stići više puta (obnova presude, više instanci
portala). Nepoznat ID se preskače. Naknadni shadow je **trajan** — ne vraća se kad presuda
istekne, kao ni odluka donesena u trenutku akcije. Poništavanje (recenzent odbaci kohortu) v1 ne
podržava.

**Kolateral** je isti kao kod presude unapred: legitimni korisnici istog prefiksa u prozoru dokaza
izgube svoje akcije (izmereno emulatorom: čitalac koji je par minuta ranije koristio prefiks
kasnije kohorte). Zato presuda po prefiksu i dalje traži drugu nezavisnu dimenziju (§4), a
prozor naknadnog shadow-a nije duži od prozora u kome je engine video dokaze.

**Namerno nema:** razloga, prefiksa, presude. Unos kaže samo koju akciju skinuti, ne i zašto.
