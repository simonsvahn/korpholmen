# Datamodell — Klubbhistorik

Detta är den konkreta entitetsmodellen. Arkitektur, dataflöden och planerade
utbyggnader finns i [`ARKITEKTUR.md`](ARKITEKTUR.md).

## Människan, källan och tolkningen

`matrikel-release` beskriver en konceptuell utgåva. Flera PDF-sorteringar av
samma lista kan senare kopplas till samma utgåva som olika `source-document`.

Alla privata matrikelkällor har dessutom samma validerade JSON-format
`matrikel-source.schema.json`. En JSON-fil motsvarar ett faktiskt
källdokument eller en faktisk sorteringsvariant och innehåller alltid samma
topplager: `document`, `release`, `columns`, `sections`, `member_rows`,
`boat_rows` och `document_notes`. Exakt ett dokument per `matrikel-release`
är primärt och får skapa person- och båtförekomster. Övriga varianter bevarar
fil, hash, sorteringsordning och strukturerade rader utan att dubblera
historiska personer.

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

Flera verkligt olika källsnapshots kan ha samma grova domäntid. Exempelvis är
2025 års Numbers-export och standardexport två skilda utgåvor med precisionen
`year`, eftersom innehållet skiljer sig men deras inbördes datum är okänt.
Den daterade exporten 2025-08-01 är en tredje utgåva. De får inte slås ihop
bara för att årtalet är detsamma.

## Gemensamt källformat

`document.original_files` lagrar ursprungligt filnamn, kanoniskt namn på den
privata källkopian, relativ källsökväg, byteantal, MIME-typ och SHA-256. De
nytillkomna `IMG_*.HEIC` har därför fått begripliga kopienamn som
`medlemsmatrikel-1987-sida-1.heic`, medan arkivoriginalen ligger helt orörda.

Varje medlemsrad har alltid samma fält, även när en äldre matrikel saknar
födelsedatum, ö eller relationskolumn. Saknade värden är tom sträng eller
`null`; de tas aldrig bort ur schemat. Båtraden bevaras ordagrant och bär en
`components`-lista där exempelvis `M/S Filifjonkan, M/S Lilla My` blir två
båtförekomster utan att originalraden ändras. En tom layoutbärande rad har
`category: blank` och inga komponenter.

De stora PDF-filerna 2023–2025 innehåller även äldre sorteringsbilagor. Dessa
ligger kvar bytebevarade i den privata källkopian men räknas inte en gång till
som medlemmar i den aktuella utgåvan.

## Frånvaro och förändring

Frånvaro ur en senare utgåva betyder `inte observerad`, inte automatiskt
utträde eller dödsfall. Ett verkligt namnbyte kan föreslås när två godkända
förekomster med samma person-ID bär olika normala personnamn. Förslaget är inte
en skrivning till Matrikelns personmaster.

Medlemsmatrisen lagras inte som en ny master. Den grupperar synliga,
bekräftade `person-occurrence` efter `person_id` och `release_id`. Invalsår är
det minsta uttryckligen belagda `induction_year`; det härleds aldrig från den
första matrikel där personen råkar synas. Klubbnamn och födelseår hämtas i
första hand från `person-ref` och annars från den senaste kopplade
förekomsten. Tom matriscell är frånvaro av observation, inte en händelse.

En avgjord källdubblett hanteras med en append-only tombstone på den extra
`person-occurrence`. Berörda `source-row` behåller råtexten men får tom
`occurrence_ids` och en `normalization_note` som pekar ut den bevarade
normaliserade förekomsten.

## Matchningsstatus

- `kopplad` — entydig maskinell träff;
- `godkand` — tidigare mänskligt godkänt beslut;
- `foreslagen` — en eller flera kandidater, inget avgörande;
- `saknas` — ingen kandidat;
- `manuell` — beslut sparat i den levande Klubbhistorik-mastern.
