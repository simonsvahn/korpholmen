# Fastighetshistorik — privat lokal-först-master

Fastighetshistorikens plats i appfamiljen finns i den gemensamma
[`ARKITEKTUR.md`](../../ARKITEKTUR.md); den konkreta modellen finns i
[`DATAMODELL.md`](DATAMODELL.md).

Detta är den kanoniska databasen för Korpholmens fastigheter och deras
historia. Appen använder samma operationslogg, IndexedDB-lager, Dropbox-synk
och datafria publiceringsmodell som Matrikeln och Båtregistret.

## Vad mastern äger

- dagens registerenheter med samma stabila ID:n som tidigare skapades i
  Matrikeln, till exempel `Alsvik 3:24`;
- historiska jord- och skiftesenheter;
- relationer mellan föregångare, stamfastigheter och avstyckningar;
- innehav med roller som ägare, lagfaren ägare, hyresgäst och brukare;
- överlåtelser, arv, auktioner och förrättningar;
- separata datumroller för kontrakt, tillträde, ansökan, förrättning,
  fastställelse och observation;
- parter, källor, evidens och källgranskningsfynd.

`current-owner-assessment` är det separata, granskade nulägeslagret. Det anger
vilka vi för närvarande tror är rätt ägare och används av Kartdata. Äldre
registerobservationer och ägarkedjor ligger kvar som historik och skrivs aldrig
över av nulägesbedömningen.

Alla 130 poster i den äldre råkedjan finns kvar ordagrant men är också
normaliserade. Person-/rollposter ligger som `holding-claim`; förrättningar,
priser och antydda byten ligger som `event-claim`. De är därmed sökbara och
visualiserbara utan att en osäker arbetsuppgift blandas ihop med en belagd
lagfart. Källstöd från bland annat Lantmäteriakterna, KBK:s minnesberättelser,
intervjuerna och Hans Lundins bokmaterial följer den enskilda strukturposten.

Matrikeln är fortsatt master för personer. De 137 importerade
person–fastighetskopplingarna heter `community-link` och betyder
**fastighetsgemenskap**, inte juridiskt ägande.

Fastighetsappen läser Matrikel skrivskyddat. Parten behåller sin historiska
eller juridiska namnform i Fastigheter, men den normala personvisningen använder
Matrikelns aktuella namn. Externa nuvarande personägare får egna, separata
person-ID:n; de slås aldrig ihop med en befintlig person genom namnlikhet.

## Källgranskad startmaster

Den privata, redigerbara källkopian finns i
`privat/kallkopior/fastighetshistorik.json`. Byggkedjan validerar alla
fastighets-, person-, händelse- och källreferenser mot Matrikeln och skapar:

- `initial-ops.json` — appens oföränderliga startoperationer;
- `research-export.json` — tabellorienterad JSON för analys;
- `fastighetshistorik.sqlite` — relationsdatabas för frågor och visualisering;
- `kallgranskning.md` — jämförelsen mellan Simons manuella tabell och senare
  fynd i Lantmäteriets akter/register;
- `manifest.json` — räknare, principer och kontrollsumma.

Bygget stoppar om en råpost saknar en existerande normaliserad målpost. Den
aktuella mastern innehåller 129 strukturerade innehavsanspråk, 145
händelseanspråk/härledda övergångar och 10 separata belagda händelser.

Bygg om och verifiera med:

```sh
npm run build:migration
npm run build:current-owners
npm run build:person-master
npm test
```

## Dropbox och publicering

Appens operationsnamnrymd är `/fastigheter/ops`. Dropbox App Folder och OAuth
delas med de andra apparna, men operationerna ligger åtskilda. Det publika
paketet byggs till `fastigheter/` och innehåller bara appskal och gemensam
kärna — aldrig startmaster, ägarnamn eller forskningsdata.

En granskad nulägesändring förs till den levande mastern append-only med
`npm run seed:current-owners`. Kommandot skriver bara den särskilda
nulägesmigrationen och rör inte historiska observationer.

Den granskade engångskopplingen för externa nuvarande personägare byggs och
skrivs med `npm run build:person-master` respektive
`npm run seed:person-master`. Den skapar nya person-ID:n i Matrikel och länkar
Fastigheters parter till dem, utan namnmatchning.
