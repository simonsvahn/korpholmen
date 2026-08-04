# Datamodell för Kartdata v2

Kartdata v2 är den aktiva, strukturerade databasen för kartans sakobjekt och
östruktur. Den äldre importen med källfält, arbetsanteckningar och
AI-förslag är ett avskilt v1-arkiv och läses inte som aktiv data.

## Aktiv data

| Entitet | Ansvar |
|---|---|
| `place` | Stabil identitet för en ö. Namnet kan ändras utan att ID:t ändras. |
| `name-record` | Föredraget, officiellt, alternativt eller historiskt önamn. |
| `data-entry` | En aktiv kartdatapost: namn, objektstyp, undertyp och granskningsstatus. |
| `data-entry-island-link` | Strukturerad koppling från en datapost till exakt ett befintligt ö-ID. |
| `data-entry-property-link` | Strukturerad koppling från en datapost till ett fastighets-ID. |

`property-ref`, `person-ref`, `external-party` och `property-owner-link` är
äldre referenskopior. De finns kvar som migrations- och offlinefallback men är
inte aktiva sakentiteter när Fastigheter och Matrikel kan läsas.

Aktiva objekttyper är endast `byggnad`, `plats`, `namnform` och
`ägaretikett`. `kartsymbol`, `annat` och den äldre pseudotypen
`ingen masterpost` är inte tillåtna i v2.

## Vad som uttryckligen har tagits bort

Följande fält och paneler ingår inte i den aktiva modellen eller exporten:

- ordagrann källuppgift;
- tidigare arbetsförslag;
- käll-ID och fria källfält;
- antecknings- och granskningsnoter;
- automatiska reservvärden från de äldre förslagskolumnerna.

V1-operationerna ligger kvar som ett tekniskt append-only-arkiv. Det krävs
för att redan gjorda manuella åtgärder inte ska kunna återuppstå genom en
gammal synkbatch. Rotposten anger `active_schema_version: 2` och appen läser
bara v2-entiteterna ovan.

## Ökoppling

`data-entry-island-link.island_id` måste peka på ett aktivt `place` med
`subtype: ö`. Byggaren gör bara säker namnnormalisering för Simons beslutade
visningsformer `Stora Korpholmen → Korpholmen` och
`Stora Sviholmen → Sviholmen`. Om en äldre rad nämner en borttagen ö eller
ett område som inte är en ö lämnas länken tom; systemet gissar inte.

## Fastighet och ägare

Fastighets-ID:n valideras mot Fastighetshistorik. Fritext lagras inte som
fastighetskoppling. Ägare kopieras inte från den äldre Kartdata-tabellen och
härleds inte direkt från en gammal registerobservation. I stället används
enbart `current-owner-assessment` i Fastighetshistorik. Saknas en sådan
bedömning visar Kartdata ingen ägare.

Kartdata läser Fastighetshistorikens `property`, `current-owner-assessment`
och `party` skrivskyddat. Om en ägarpart har `person_id` hämtas personens
aktuella visningsnamn skrivskyddat från Matrikel. Organisationer och oupplösta
parter visas med partnamnet från Fastigheter. Ingen av dessa poster skrivs till
Kartdatas operationslogg och ingen namnlikhet används för att gissa identitet.
Historiska observationsdatum och ägarkedjor visas i Fastighetshistorik, inte i
Kartdatas nulägeskolumn.

## Lagring och publicering

Den levande Kartdata-mastern är append-only-loggen i `/kartdata/ops`. En privat,
reproducerbar v2-migration byggs i
`privat/migrering-2026-08-04-ren-v2/`. GitHub Pages innehåller bara appskalet;
varken dataposter, personnamn eller fastighetsdata byggs in i publiceringen.

Fastigheter och Matrikel cachas som skrivskyddade snapshots i Kartdatas lokala
IndexedDB. Deras operationer läggs aldrig i `/kartdata/ops`.
