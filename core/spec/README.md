# Specifikacija protokola — v1 (nacrt)

**Status:** nacrt za proof of concept. Menja se dok PoC ne potvrdi protokol; posle toga
izmene samo uz novu verziju.
**Izvor istine:** ovaj folder. Kod u `core/`, `sdk/` i `ts/` prati spec, ne obrnuto.

| Dokument | Sadržaj |
| --- | --- |
| [`token.md`](token.md) | token pregleda: format, potpis (Ed25519), provera, redosled provera, rezultati |
| [`events.md`](events.md) | događaji: iz browsera (`ts/`) i sa backenda portala (SDK); endpointi |
| [`verdicts.md`](verdicts.md) | presude: kako engine javlja SDK-u šta da radi sa kohortom |
| [`sdk.md`](sdk.md) | ugovor SDK-a: tok jednog glasa/komentara, konfiguracija, šta SDK NE SME |
| [`test-vectors/`](test-vectors/) | zajednički test vektori; svaki SDK ih prolazi u CI-ju |

## Principi (važe za sve dokumente)

1. **Browser je neprijateljska teritorija.** Sve što dolazi iz browsera može biti lažno.
   Browser meri i šalje; nikad ne odlučuje i nikad ne zna pragove.
2. **Pragovi se ne izlažu.** Ništa što napadač može da pročita (token, odgovor API-ja,
   JS kod) ne sadrži pragove ni razloge presude.
3. **Isti odgovor bez obzira na presudu.** Portal korisniku vraća isti odgovor za glas koji
   se računa i za glas koji ide u shadow. Napadač ne sme da sazna da je otkriven.
4. **Pun IP ne napušta portal.** SDK šalje samo mrežni prefiks (IPv4 /24, IPv6 /48).
   Collector koji direktno prima zahteve iz browsera skraćuje IP pre bilo kakvog upisa.
5. **Unapred kompatibilno.** Nepoznata polja u JSON-u se ignorišu. Nepoznata vrednost
   enumeracije se tretira kao najslabija poznata (npr. nepoznata akcija presude = `none`).

## Termini

Ključne reči **MORA**, **NE SME**, **TREBA**, **MOŽE** imaju značenje kao MUST / MUST NOT /
SHOULD / MAY u RFC 2119.

| Termin | Značenje |
| --- | --- |
| portal | jedan sajt-klijent, identifikovan sa `portal` (npr. `demo.local`) |
| post | jedan članak na portalu, `post` (ID koji portal već koristi) |
| prikaz (view) | jedno učitavanje stranice posta u browseru; identifikovan sa `vid` |
| akcija | glas ili komentar koji stiže na backend portala |
| presuda | odluka engine-a o kohorti: `none`, `shadow`, `challenge` |
| shadow | akcija se čuva i prikazuje svom izvoru, ali se ne računa u javni brojač |

## Vreme i identifikatori

- Sva vremena su **milisekunde od Unix epohe (UTC)**, celi brojevi, polje sa sufiksom `_ms`
  ili ime `t` / `iat`.
- `vid` = 16 nasumičnih bajtova, base64url bez paddinga (22 znaka). Generiše ga **server**
  (`ppd-api`) pri izdavanju tokena — nikad browser.
- base64url u celom protokolu: alfabet `A–Z a–z 0–9 - _`, **bez** `=`. Dekoderi MORAJU biti
  strogi (vidi `token.md` §4).

## Verzionisanje

Verzija protokola je u prefiksu tokena (`ppd1`), u putanjama (`/v1/...`) i u polju `v`
koverte događaja. Nekompatibilna izmena = nova verzija; stara se podržava paralelno dok je
SDK-ovi ne napuste.
