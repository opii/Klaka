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
  bihevioralni ili infrastrukturni signal; ciljni (iste mete), tekstualni (ista formulacija) ili
  vremenski (zajedno, u kratkom razmaku) samo ako se ponavlja na više postova i odstupa od
  organske publike (koncept §2a, pravilo preseka). Vremenski signal ne važi u prozoru promocije
  posta (`promotion`, koncept §8).
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
- **glas** — oduzima se od javnog zbira; glasač i dalje vidi zbir sa svojim glasom (`sdk.md` §2).

**Dopuna.** Dok presuda važi, engine u svakom krugu u kome prefiks i dalje ima nalaz dopisuje u
stream uračunate akcije prefiksa iz prozora kojih još nema u naknadnom shadow-u te presude. To su
akcije koje je portal prihvatio pre nego što je presuda stigla do Valkey-ja, a u bazu su stigle
posle nje (SDK šalje događaje u paketima; izmereno emulatorom: komentar prihvaćen 45 ms pre
presude, primljen 150 ms posle nje), ili ih je prihvatio dok nije video Valkey. Poređenje ide
preko spiska presude, ne preko satova portala i baze. Dopuna ide pod istu presudu (audit), ključ
presude se ne menja, a prozor se ne širi unazad.

Obrada MORA biti idempotentna: isti unos može stići više puta (obnova presude, više instanci
portala). Nepoznat ID se preskače. Naknadni shadow je **trajan** — ne vraća se kad presuda
istekne, kao ni odluka donesena u trenutku akcije. Poništavanje (recenzent odbaci kohortu, §6) v1
ne podržava.

**Kolateral** je isti kao kod presude unapred: legitimni korisnici istog prefiksa u prozoru dokaza
izgube svoje akcije (izmereno emulatorom: čitalac koji je par minuta ranije koristio prefiks
kasnije kohorte). Zato presuda po prefiksu i dalje traži drugu nezavisnu dimenziju (§4), a
prozor naknadnog shadow-a nije duži od prozora u kome je engine video dokaze.

**Namerno nema:** razloga, prefiksa, presude. Unos kaže samo koju akciju skinuti, ne i zašto.

## 6. Pregled (recenzent)

Engine presuđuje sam (§4); recenzent u `klaka-api` (red za pregled) presudu **potvrđuje** ili
**odbacuje**. Odluka ide u audit (`verdict_review`: ko, kada, napomena) i daje oznake za meru
uspeha — preciznost reda za pregled (koncept §11).

- **Potvrda** je samo oznaka.
- **Odbacivanje** zaustavlja presudu prefiksa ako još važi: nova revizija `none` u Valkey-ju i u
  audit-u, sa rokom koliko je trajala odbačena presuda. Dok `none` važi, engine prefiks ni ne
  presuđuje ponovo ni ne dopunjuje naknadni shadow (§5), i kad ga detektor i dalje nalazi —
  inače bi akcije koje portal posle odbacivanja legitimno uračuna otišle u naknadni shadow. Kad
  `none` istekne, a prefiks je i dalje nalaz, engine izdaje novu presudu, i ona ide u red.
- Naknadno skinute akcije ostaju skinute (§5).

Uz presudu sa komentarima recenzent vidi i opis modela (šta grupa poručuje, stav, kohezija,
toksičnost, sažetak; `docs/llm.md` §5b) i ulogu kohorte — pojačivači, ćaci, razvodnjivači, sa
razlozima (`docs/caci.md` §1). Oba su savetodavna: presuda ne zavisi od njih, a odluka je
recenzentova.

UI recenzenta je na posebnom listener-u, nikad na javnoj adresi `/v1/view`. Prijava je HTTP
Basic (ime i token recenzenta), a odluku prima samo sa istog origin-a (browser bi Basic podatke
poslao i sa tuđe stranice). Bez JavaScript-a; sadržaj od korisnika portala (tekst komentara,
pseudonim) se escape-uje.
