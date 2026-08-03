# Båtregister

Båtregistrets ansvar för stabila båtar och dess ID-länkar till övriga mastrar
finns i den gemensamma [`ARKITEKTUR.md`](../../ARKITEKTUR.md).

Redigerbar lokal-först-master för KBK:s båtar och båtbilder. Appskalet är
datafritt på GitHub Pages. Privat båtdata ligger lokalt i IndexedDB och synkas
som oföränderliga operationsbatcher till `/batregister/ops` i samma Dropbox
App Folder som Matrikeln. Bilder ligger separat i `/batregister/bilder`.

Efter första fullständiga synken finns alla båtposter, Matrikelns personlista
och samtliga båtbildsvarianter i enhetens IndexedDB. Appen kan därefter
startas, läsas och redigeras offline. Nya bilder lagras först lokalt och ligger
i en beständig uppladdningskö tills Dropbox kan nås igen. Service workern
cachar bara det datafria appskalet; privat data blandas aldrig in i webb-cachen.

Den låsta startkopian byggs av arbetskopiorna i `privat/kallkopior/`:

```sh
npm run build:migration
npm test
npm run build:publish
```

Spårbara rättelser efter grundimporten ligger som privata operationsdokument i
`privat/korrigeringar/`. Seed-kommandot läser dem efter startmastern och skriver
varje korrigeringsenhet som en ny oföränderlig Dropbox-batch; tidigare batcher
skrivs aldrig över.

En korrigering av personidentitet får bara byta länken, aldrig båtens råa
ägartext. Rättelsen 2026-08-03 tombstonar därför de tidigare länkarna
Lasse-Maja/Tillfälligheten → Peter Holm och skapar motsvarande länkar till
Peter Neretnieks, eftersom källfältet uttryckligen anger »Junior Peter = Peter
Neretnieks«. Den oberoende BossaNova → Peter Holm-länken lämnas oförändrad.

På localhost kan startkopian aktiveras och därefter laddas upp till Dropbox.
Entydiga personnamn och klubbnamn länkas automatiskt till Matrikelns stabila
person-ID. Därutöver bygger startmastern reproducerbart på Simons uttryckligen
godkända och avvisade beslut. Båtar kan kopplas till person, stabil FAMILJ eller
stabil SLÄKT. Den gemensamma anknytningssökningen börjar med ett personnamn och
låter användaren välja rätt omfattning; en koppling på hög nivå syns även när
en underliggande person eller familj filtreras fram. Familje- och släktmodellen
hämtas ur Matrikelns lokalt cachade data. Oklara fall granskas i det separata
Excelarket.
