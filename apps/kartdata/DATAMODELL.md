# Datamodell för Kartdata

Kartdata är både granskningsapp för vad som faktiskt står på en viss
kartutgåva och kanonisk master för öar, platser och byggnader. Den är inte
master för fastighetsägande eller person–fastighetsrelationer.

| Entitet | Ansvar |
|---|---|
| `source` | Arbetsbokens identitet, blad, intervall, kontrollsumma och uttalade kvalitetsläge. |
| `map-entry` | En oföränderlig källrad med alla elva arbetsbokskolumner samt ett separat granskningslager. |
| `place` | Stabil identitet för ö, halvö, udde, äng, park, strand, berg, vattenområde eller annan plats. |
| `building` | Stabil identitet för en fysisk byggnad oberoende av dess namn över tid. |
| `name-record` | Föredraget, officiellt, historiskt eller alternativt namn med källa, status och giltighetsintervall. |
| `place-relation` | Exempelvis att Sahlskär är `del_av` Korpholmen. |
| `object-property-link` | Källspårbar geografisk koppling från plats/byggnad till ett fastighets-ID. Betyder inte ägande. |
| `map-entry-link` | Granskat påstående att en bestämd kartpost avser ett bestämt plats- eller byggnadsobjekt. |

Varje `map-entry` har två tydliga lager:

1. `source_*` samt `prior_*` är importerade bytebevarande uppgifter. De
   redigeras aldrig i appen. De äldre beslutskolumnerna heter avsiktligt
   `prior_type_decision` och `prior_correction`, eftersom Simon inte har
   bekräftat att arbetsboken är fullständigt kvalitetsgranskad.
2. `review_*` skrivs som nya operationer när Simon bekräftar, rättar,
   osäkerhetsmarkerar eller avför en post.

`review_status` är `ogranskad | bekräftad | rättad | osäker | utgår`.
Godkända objektfält är visningsnamn, objektklass, undertyp, överordnad
ö/plats, fastighets-ID:n och granskningsnot.

## Förhållandet mellan plats, byggnad och fastighet

- `plats` och `delområde` är samma objektklass. Delområde uttrycks
  genom relationen `del_av`; undertypen kan vara ö, halvö, udde, äng, park,
  strand, berg eller vattenområde.
- `byggnad` förblir en egen fysisk objektklass.
- `fastighet` förblir en juridisk registerenhet och ägs av
  Fastighetshistorik.

Startmastern innehåller stabila platsobjekt för öarna. Korpholmen, Sviholmen
och Sahlskär bär uttryckliga beslut från Simon; övriga startobjekt är tydligt
märkta som ogranskade förslag från KARTA-2025. Ett separat namnunderlag lägger
till historiska namn, vardagsnamn och oidentifierade äldre holmnamn. De senare
har egna plats-ID:n med status `osäker` i stället för att gissas ihop med en
nutida ö. Byggnader skapas först när de granskas eller läggs in manuellt. En
ogranskad `map-entry` skapar aldrig automatiskt ett masterobjekt.

## Namn och tid

Objektets ID ändras inte när namnet ändras. `Korpholmen` kan därför vara
föredraget namn samtidigt som `Stora Korpholmen` är en officiell namnpost.
Varje namn, platsrelation och fastighetskoppling kan bära `valid_from`,
`valid_to`, `source_ids` och `review_status`.

Namnunderlagets operationer har ett eget `device_id`. Befintliga grund- och
strukturmigrationer är därför bitidentiska även när fler namn tillkommer.
När ett importerat namn redigeras i appen återanvänds dess namnpost och dess
källor, datering och notering bevaras; borttagning blir en senare tombstone i
operationshistoriken.

## Lagring

Källkopior och reproducerbara migreringar ligger privat under `privat/`.
Den levande mastern är den append-only operationslogg som synkas i
`/kartdata/ops`. IndexedDB är en lokal arbetskopia och JSON-exporten är en
härledd produkt, inte en ny master.
