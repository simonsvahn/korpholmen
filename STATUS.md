# Aktuellt läge

Senast kontrollerad: 2026-08-16.

| Master | Aktiv generation 2 | Skrivläge | Nästa steg |
|---|---:|---|---|
| Personer och familjer | revision 21 | Skrivskyddad | V2-läsaren har personregister, familjer, relationsträd och tvärlänkar; säker writer byggs som en separat fas |
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

Tidigare appfunktionalitet har en namngiven kodreferens i Git:
`v1-ui-before-v2-cutover-2026-08-16` (`c8fabc7`). V2 ska nu granskas app för
app mot denna referens. Funktioner behålls, byggs om eller gallras först efter
ett tydligt beslut; den äldre koden kopplas aldrig direkt till dagens writer.
Se `FUNKTIONSMIGRERING-V1-V2.md`.

En appvis funktionsrekommendation finns i
`FUNKTIONSREKOMMENDATION-V1-TILL-V2.md`. Den skiljer mellan funktioner som bör
återtas nu, byggas om senare och lämnas i V1-arkivet samt föreslår byggordning
för alla sju ägarappar och Explorer.

Personer & familjers publicerade V2-läsare använder den gemensamma
byte-transporten för Person- och Matrikelmaster. Den äldre personappens
JSON-transport används endast av generation 1-flödet och kan därför inte längre
orsaka startfelet `Den nya masterläsaren kräver en byte-lästransport`.

En utökad läsversion är lokalt verifierad i arbetsgrenen
`codex/personer-familjer-funktionsatertag`. Personer är fortsatt standardvy;
Familjer är en sekundär vy över 62 stabila familjeenheter. Träden räknas från
faktiska partner- och förälder–barn-relationer, även för äldre familjeenheter
som saknar den senare tekniska medlemsregeln. Personakten länkar med stabila
ID:n till Matrikel, Båtregister, Fastigheter, Dokumentarkiv och Korpholmen runt.
Ingen gammal släktkrets, kopierad sakdata eller generation 1-writer har
återaktiverats. Versionen är ännu inte publicerad.

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

## Publicerat: Korpholmen runt topptider och tidsnormalisering

Webbskalet publicerades 2026-08-16 som
`2026-08-16-korpholmen-pwa-45`. Samma klass redovisas under separata
huvudavsnitt för Stora respektive Lilla banan. Varje
klass visar först tio rader med möjlighet att visa hela klassen. Tidsstatus
filtrerar inte bort något resultat: osäkra numeriska tider rangordnas med en
tydlig märkning, medan minimitider och Fusk visas utan placeringssiffra.
Endast de 17 av 474 poster som saknar strukturerad bana eller klass visas i en
separat ogrupperad lista. Person- och båtkoppling påverkar inte om ett resultat
får visas.

Resultatmaster revision 5 aktiverades 2026-08-16 med SHA-256
`ec19298acfbe59de2a160a5014aeff917643eaa4cc832f0a8b90edc9c0810f63`.
Den bevarade kandidaten finns i
`arbetsmaterial/korpholmenrunt-tidsnormalisering-2026-08-16/kandidat-revision-5-v4/`.
Den bygger på revision 4 och ändrar 39 av 474 resultatposter utan att
ändra något råvärde: 32 automatiska normaliseringar samt sju uttryckliga
mänskliga tidsbeslut. Hundradelarna i 2010 och 2011 års råtider stryks utan
avrundning. Två frågeteckentider behålls som osäkra, 35,67 och 80,95 har
beslutats som 35:07 respektive 80:05 med status osäker, två plustider markeras
som minimitider och Fusk visas som utfall i stället för tid. Revision 5 har 471
numeriskt rangordningsbara resultat och tre synliga resultat utan exakt
numerisk tid. Generation 1-skrivaren är oförändrad och revision 5 är fortsatt
en skrivskyddad läsmaster.

Backupen med den tidigare aktiva pekaren, hela revision 4 och en kort
återställningsnot finns i:

`/Users/simon/Dropbox/AI/Projekt/9 Arkiv/Korpholmen säkerhetskopior/2026-08-16 före Korpholmen runt revision 5`

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
