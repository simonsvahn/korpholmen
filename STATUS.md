# Aktuellt läge

Senast kontrollerad: 2026-08-16.

| Master | Aktiv generation 2 | Skrivläge | Nästa steg |
|---|---:|---|---|
| Personer och familjer | revision 21 | Skrivskyddad | Den vanliga appen läser nu V2 direkt; separat writer-byte planeras först när ett enkelt personformulär finns |
| Matrikel | revision 10 | Aktiv writer | Fortsatt normal användning och logikkontroll |
| Båtregister | revision 5 | Aktiv writer | Arbeta vidare och granska direkt i den vanliga V2-appen; generation 1 och revision 4 är bevarade som återställningspunkter |
| Fastigheter | revision 22 | Aktiv writer | Fortsatt normal användning och kontroll av ändringskvitton |
| Dokumentarkiv | revision 4 | Skrivskyddad | Den vanliga appen läser nu V2; fortsätt dokumentgranskning och gör writer-byte senare |
| Kartdata | revision 1 | Skrivskyddad | Den vanliga appen läser nu V2 och Fastighetsmaster; writer-byte senare |
| Korpholmen runt | revision 4 | Skrivskyddad | Den vanliga appen läser nu V2 med Person- och Båtmaster; writer-byte senare |

Generation 1-data är fryst eller fortsatt ensam writer enligt tabellen ovan.
Inget writer-byte får ske bara genom att kod finns: privat fullbackup,
sent-delta-kontroll, återställningsprov och kontroll av korsapplänkar krävs
först.

Det stora migreringsarbetsmaterialet och tidigare projektutkast är flyttade
till det externa säkerhetskopiearkivet. Den aktiva Git-arbetsytan ska normalt
vara ren mot `main`; enda tillåtna avvikelsen är en tydligt namngiven pågående
arbetsgren.

## Aktuella webbadresser och katalognamn

- `personer-familjer/` är appen **Personer & familjer**.
- `matrikel/` är appen **Matrikel** för medlemskap, klubbnamn, invalsår och
  historiska matrikelutgåvor.
- `klubbhistorik/` innehåller endast en omdirigering till `matrikel/` så att
  äldre bokmärken inte går sönder.

Explorer är en skrivskyddad sökvy över samtliga sju aktiva V2-mastrar. Den
innehåller ingen egen sakmaster och läser inte längre generation 1:s
operationsloggar. I den lokalt verifierade arbetsgrenen indexeras 988
sökbara objekt från revisionerna `21/10/5/22/4/4/1`.

V2-appskalet är ombyggt efter en navigeringsregression i den första
publiceringen. Korpholmen runt, Dokumentarkiv och Kartdata har nu egna
fungerande V2-vyer bakom varje synlig intern menyknapp; Personer & familjer
använder rätt byte-transport; alla åtta appar finns i samma appväxlare.
Dokumentarkivets lokala V2-läge kan visa de bevarade källbilderna och Explorers
djuplänkar går till en bestämd Kartdatapost. Kontraktstester spärrar en ny
publicering med ofullständig appväxlare eller synliga V2-flikar utan V2-rutt.

Personer & familjers publicerade V2-läsare använder den gemensamma
byte-transporten för Person- och Matrikelmaster. Den äldre personappens
JSON-transport används endast av generation 1-flödet och kan därför inte längre
orsaka startfelet `Den nya masterläsaren kräver en byte-lästransport`.

De historiska Dropbox-namnrymderna `/matrikel/ops` för personmasterns
generation 1 och `/klubbhistorik/ops` för medlemsmasterns generation 1 är
frysta revisionsspår. De byts inte om eftersom ett sådant byte skulle bryta
återställning och äldre kontrollsummor; de exponeras inte som appnamn.

## Båtbilder

Båtmaster revision 4 återför de bildreferenser som utelämnades när revision 3
byggdes. Samtliga 260 refererade originalfiler har kontrollerats mot SHA-256.
Den aktiva mastern innehåller nu 140 bildposter för 122 båtar. Generation 1 är
orörd och en separat fullbackup finns från före korrigeringen. Båtappen
försöker först med den lokala läskopian och hämtar annars den SHA-refererade
bilden från `/batregister/bilder`; webbläsartestet visar 122 av 122
bildförsedda båtar utan en trasig bild.

Revision 5 är aktiv efter en separat källkontroll mot de fulla båtbladen. Sex
felaktiga länkar från utsnitt av tvåbåtsblad har tagits bort och tre korrekta
utsnitt har lagts till för Igor, Gösta Jansson och Snabbt ut till öarna. Linje
3 behåller sitt redan korrekta utsnitt. Appen kontrollerar dessutom varje
cachad bildblobbs SHA-256 före visning, så en gammal felbild kan inte längre
återanvändas för en ny eller rättad bildpost.

Backupen före revision 5 finns i:

`/Users/simon/Dropbox/AI/Projekt/9 Arkiv/Korpholmen säkerhetskopior/2026-08-16 före bildreparation Båtregister`

## Båtregistrets äldre läskomplement

Den aktiva V2-mastern är ensam skrivmaster. För att inte dölja redan utfört
arbete får båtappen dessutom läsa generation 1 skrivskyddat och visa det som
tydligt märkt **Tidigare strukturerad master** på rätt V2-båt, även när den
äldre identiteten har slagits ihop genom en V2-ompekning. Komplementet
innehåller vid senaste kontrollen 236 grundposter, 199 strukturerade
specifikationsobservationer, 126 ägarobservationer, 106 händelser och 50 öppna
se-över-frågor. Det kan sökas och filtreras, men inget därifrån godkänns eller
skrivs automatiskt in i V2.

## Säkerhetskopia före appkopplingen

En byteverifierad fullkopia av de sju aktiva pekarna, deras masterrevisioner,
cutover-markörer och Git-läge finns i:

`/Users/simon/Dropbox/AI/Projekt/9 Arkiv/Korpholmen säkerhetskopior/2026-08-15 före V2-appkopplingar`
