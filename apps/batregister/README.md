# Båtregister

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

På localhost kan startkopian aktiveras och därefter laddas upp till Dropbox.
Entydiga personnamn och klubbnamn länkas automatiskt till Matrikelns stabila
person-ID. Därutöver bygger startmastern reproducerbart på Simons uttryckligen
godkända och avvisade beslut. Båtar kan kopplas både till en person och till en
familj; familjens medlemmar hämtas ur Matrikelns lokalt cachade personlista.
Oklara fall granskas i det separata Excelarket.
