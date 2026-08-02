# Datamodell — Klubbhistorik

Detta är den konkreta entitetsmodellen. Arkitektur, dataflöden och planerade
utbyggnader finns i [`ARKITEKTUR.md`](ARKITEKTUR.md).

## Människan, källan och tolkningen

`matrikel-release` beskriver en konceptuell utgåva. Flera PDF-sorteringar av
samma lista kan senare kopplas till samma utgåva som olika `source-document`.

`person-occurrence` är en ordagrann rad i medlemskolumnen. Den bär bland annat
utgåva, ordning, råtext, medlemskategori, rått invalår, det personnamn som kan
utläsas och en separat identitetsmatchning mot Matrikelns `person_id`.

`boat-occurrence` är en namngiven båt i fartygskolumnen. Den bär råtext,
prefix, eventuellt registreringsår och en separat matchning mot Båtregistrets
`boat_id`. Förekomsten innebär att båten står i utgåvan, inte automatiskt vem
som ägde den.

`person-ref` och `boat-ref` är privata läskopior för sökning och länkning.
Deras `external_id` är fortsatt auktoritativt i Matrikel respektive
Båtregister. De är inte nya identitetsmastrar.

## Tider

Källutgåvans `as_of` är domäntid: när ögonblicksbilden avser. HLC på en
operation är transaktionstid: när en import eller rättelse registrerades.
Dessa två tider får aldrig blandas ihop.

## Frånvaro och förändring

Frånvaro ur en senare utgåva betyder `inte observerad`, inte automatiskt
utträde eller dödsfall. Ett verkligt namnbyte kan föreslås när två godkända
förekomster med samma person-ID bär olika normala personnamn. Förslaget är inte
en skrivning till Matrikelns personmaster.

## Matchningsstatus

- `kopplad` — entydig maskinell träff;
- `godkand` — tidigare mänskligt godkänt beslut;
- `foreslagen` — en eller flera kandidater, inget avgörande;
- `saknas` — ingen kandidat;
- `manuell` — beslut sparat i den levande Klubbhistorik-mastern.
