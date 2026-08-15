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

Personnamn är inte kanonisk båtdata. Båtlänken lagrar personens stabila ID och
appen läser Matrikel skrivskyddat för aktuellt `display_name`. Äldre
`person_display_name` ligger kvar endast som offline-/migrationsfallback.

I en lokal Båtmasterpilot kan en privat Matrikel-snapshot byggas in i
förhandsvisningen. Den används bara som skrivskyddad namn- och länkkontext och
publiceras aldrig. Pilotens ägargranskning läser den privata inventeringsfilen,
visar återstående fritextposter och sparar granskningsbeslut separat från
mastern. Rollen `owner`, ägarpart, tid och källor är strukturerade. Bara beslut
med status **Klar för införande** exporteras till en validerad ändringskö;
Dropbox-mastern skrivs först efter separat torrkörning och ett uttryckligt
`--write`. Kandidater godkänns aldrig automatiskt. Se
[`DATAMODELL-BATMASTER.md`](./DATAMODELL-BATMASTER.md).

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

## Källkritik för årtal

Registerblad och protokoll väger tungt för båtarnas fakta, namn och noterade
transaktioner. Dokumentets årtal är däremot i första hand ett registrerings-
eller observationsår. Det får inte automatiskt göras till inköpsdatum,
ägarbytesdatum, namnbytesdatum eller dopdatum.

När själva händelsen inte uttryckligen dateras ska registret därför:

- ange händelsens tidpunkt som okänd eller osäker;
- bevara året som registreringsår tillsammans med dess källtyp;
- skilja den källbelagda transaktionen från en senare tolkning av när den skedde;
- aldrig låta ett exakt strukturerat årtal ge högre säkerhet än originalkällan.

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

## Generation 2

Den aktiva läsmastern har 236 stabila båtidentiteter och läses genom en
SHA-verifierad pekare. Generation 1 är fortfarande ensam skrivare tills
Båtregistrets vanliga redigeringsvy har kopplats till den nya writern och hela
bytet har säkerhetskopierats och slutprovats. Den nya writern sparar en ny
masterrevision och ett separat ändringskvitto per tryck på **Spara**; den
skriver aldrig om en befintlig revision och avvisar ändringar från en gammal
flik eller enhet.
