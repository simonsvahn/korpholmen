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
| `property-ref` | Skrivskyddad referens till en fastighet i Fastighetshistorik. |
| `data-entry-property-link` | Strukturerad koppling från en datapost till ett fastighets-ID. |
| `person-ref` | Skrivskyddad referens till en säkert länkad person i Matrikeln. |
| `external-party` | Ägarpart i Fastighetshistorik som ännu saknar säker Matrikel-länk. Kan vara person, organisation, dödsbo eller namngrupp. |
| `property-owner-link` | En ägare i Fastighetshistorikens granskade nulägesbedömning och dess länk till `person-ref` eller `external-party`. |

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

Om nulägesbedömningens part redan har ett `person_id` som finns i Matrikeln skapas
en `person-ref`. Annars skapas en `external-party`. Ingen namnlikhet används
för att gissa att två personer är samma. Historiska observationsdatum och
ägarkedjor visas i Fastighetshistorik, inte i Kartdatas nulägeskolumn.

## Lagring och publicering

Den levande mastern är append-only-loggen i `/kartdata/ops`. En privat,
reproducerbar v2-migration byggs i
`privat/migrering-2026-08-04-ren-v2/`. GitHub Pages innehåller bara appskalet;
varken dataposter, personnamn eller fastighetsdata byggs in i publiceringen.
