# Båtregister: byte till generation 2

Detta är den operativa sanningen för Båtregistrets writer-byte. Sakmodellen är
masterfil + separat ändringshistorik. Generation 1 bevaras oförändrad som
historiskt arkiv efter bytet.

## Omfattning

- Generation 2 innehåller 236 aktiva båtidentiteter och 2 identitetsompekningar.
- Båtens vanliga fält, bilder och strukturerade tidslinje redigeras i samma app.
- Ägare väljs ur Personmastern som person eller uttryckligen tillåten
  familjeenhet. Namnet kopieras inte in som en andra sanning.
- Varje Spara skapar en ny oföränderlig masterrevision och ett ändringskvitto.
- En gammal flik får revisionskonflikt och kan inte skriva över nyare data.
- Efter aktivering blockerar en beständig cutover-markör alla V1-operationer.
- Bildfiler ligger fortsatt i `/batregister/bilder`; det är masterreferensen till
  bilden som versionshanteras i generation 2.

Att många båtar ännu bara har namn/identitet är avsiktligt. Ogranskade V1-fakta
flyttas inte automatiskt in bara för att fylla tomma fält. De kan granskas och
kompletteras i den vanliga aktiva V2-appen.

## Kontroller före aktivering

1. Datafri app byggd och testad på dator och mobil.
2. Full backup av Båtregister V1, Båtregister V2, Personmaster,
   Korpholmen runt och befintliga cutover-markörer.
3. Backupens samtliga filer verifierade med SHA-256.
4. V1 jämförd mot checkpoint: 61 batchfiler och 9 081 operationer, ingen sen
   svans.
5. Korpholmen runt: 330 stabila båtreferenser mot Båtmaster revision 3.
6. Kopieprov: ny V2-revision, historikkvitto, tom väntande kö, V1-spärr och
   byteexakt återställning.
7. Det datafria appskalet med både V2-läge och V1-spärr publicerat innan den
   privata cutover-markören aktiveras.

Förkontroll och aktivering görs med samma verktyg:

`node verktyg/aktivera-batregister-writer-byte.mjs <privat rot> <backuprot> --verify-only`

Byt bara sista argumentet till `--activate` efter att det datafria appskalet är
publicerat. Verktyget avbryter om V1 avviker från backupen, beroenden har glidit
eller någon av de 330 båtlänkarna i Korpholmen runt inte längre går att lösa.

## Återställning

Säkerhetskopian ligger utanför projektet i den daterade arkivmapp som anges som
`<backuprot>` vid aktiveringen. Där finns även `MANIFEST-SHA256.txt` och
aktiveringskvittot `BATREGISTER-V2-AKTIVERING.json`.

Om bytet måste backas:

1. Stäng alla öppna Båtregisterflikar.
2. Flytta undan den aktuella mappen `batregister-generation2` — skriv inte över
   den enda kopian av eventuella nya V2-ändringar.
3. Återställ `batregister-generation2` och `generation2-cutover` från
   säkerhetskopians `privat-dropbox`.
4. Kontrollera backupen med `shasum -a 256 -c MANIFEST-SHA256.txt`.
5. Ladda om appen. Utan en aktiv `batregister`-markör återgår appen till den
   orörda V1-mastern.

V1-mappen behöver normalt inte återställas eftersom aktiveringen aldrig ändrar
dess operationsfiler. Gör det bara om en separat kontroll visar att V1 faktiskt
har förändrats.
