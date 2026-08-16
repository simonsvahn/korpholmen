# Funktionsrekommendation per app — från V1 till V2

Senast bedömd: 2026-08-16.

Detta är rekommendationen för vilka användarbehov från den äldre appfamiljen
som ska lyftas in eller byggas om i V2. Jämförelsen utgår från den frysta
Git-referensen `v1-ui-before-v2-cutover-2026-08-16` (`c8fabc7`) och dagens
V2-kod.

V1 är här en **funktionsreferens**, inte en datamodell som ska återaktiveras.
Äldre funktioner byggs mot dagens V2-mastrar och stabila ID:n. Gamla
operationsloggar, Dropbox-sökvägar eller dubbla mastrar kopplas inte tillbaka.

## Samlad rekommendation

| App | Dagens V2 | Funktioner att ta tillbaka eller bygga | Funktioner att inte ta tillbaka | Omfattning |
|---|---|---|---|---|
| Personer & familjer | Personlista, sekundär familjevy, relationsträd och stabila tvärlänkar | Enkel person- och relationsredigering med separat writer-byte | Släktkretsar som huvudmodell, överlappande manuella SLÄKT-grupper, medlemsstatus och kopierade fastighetsuppgifter | Medel återstår |
| Båtregister | Nära full vardagsapp och aktiv writer | Begripliga källor, person-/familjefilter, kompakt listläge och ren avslutning av granskningsfrågor | Gamla batchpaneler och publika förslagsköer, redigering av generation 1 samt ägandeslutledning från matrikelplacering | Liten–medel |
| Fastigheter | Bra tabell, tidslinje och aktiv writer | Fastighetsbildning, grupperat samägande, källfördjupning och redigering av struktur | Forskningsdatabasens fulla evidensmodell, bred personkoppling som ser ut som ägande och flera lager av nuvarande ägare | Medel |
| Dokumentarkiv | Fungerande V2-läsare med sju vyer | Full typfiltrering, dokumentpaket, kompakta registerkopplingar, roller och versionsspår | Hyperlänk i varje namnform, stort sambandsnät, gamla blandade länkar och krav på detaljroller för varje person | Medel–stor |
| Korpholmen runt | Fungerande resultat- och analysläsare | Källbilder, resultatredigering, CSV-export och enkel V2-writer | AI-matchning i vardagsvyn, flera godkännanden per förekomst, påhittade besättningsroller och råimport som publik knapp | Medel |
| Matrikel | Mest komplett V2-app | Klubbliv med roller/utmärkelser och ett säkert flöde för nya utgåvor | Översikt/Förändringar, sidhänvisningsbrus, familje-/släktvyer och härlett båtägande | Liten–medel |
| Kartdata | Fungerande atlas, struktur, kö och tabell | Enkel redigering av objekt, namnformer och länkar samt säker borttagning/återställning | AI-arbetsfält, kopierade ägarnamn, onödiga dubbla platslänkar och oklara objekttyper | Stor |
| Explorer | Enkel totalsökning | Samlad personakt och tvärgående, tidsfiltrerad navigation | Egen writer/master, kopierade profiler, länkar från enbart namnlikhet och ett blandat relationsnät | Stor |

## Gemensam regel för alla appar

Följande V1-egenskaper är värda att bevara överallt:

- sökning och relevanta filter;
- stabila djuplänkar till en bestämd post;
- källor och originalbilder på begäran, inte som ständigt brus;
- en begriplig detaljvy med strukturerade uppgifter och historik;
- **Spara** som en egen handling, skild från **Stäng**;
- tydligt besked om appen är läsbar eller skrivbar;
- revisionskonflikt i stället för tyst överskrivning;
- en enkel **Se över**-markering när ett verkligt mänskligt beslut återstår.

Följande ska inte återinföras som normal V2-funktion:

- gamla generation 1-writers eller bootstrapknappar;
- flera parallella granskningsstatusar för samma vardagsfråga;
- redigering av kopierade namn som ägs av en annan master;
- AI-förslag som ser ut som godkända fakta;
- administrativa migreringsverktyg i den vanliga publika appen;
- synliga knappar som bara fungerar i V1-läget.

## 1. Personer & familjer

### Dagens V2

V2 har en snabb personlista med sökning på namn, klubbnamn och kontext, filter
för livsstatus och medlemsnivå samt ett personkort med namnformer, livsuppgifter
och direkta relationer. Den lokalt verifierade utökningen har den gemensamma
undermenyn **Släkter · Familjer · Personer**, V1-liknande flergenerationsträd
från faktiska relationer och stabila länkar till övriga sakmastrar. Den är
fortsatt skrivskyddad.

### Återta eller bygg nu

1. **Visuellt släktträd från faktiska relationer — byggt för parallell publicering.** Nuvarande
   **Släkter** behålls och den V1-inspirerade flergenerationsvyn ligger bredvid
   som **Släktträd**. Den ritas som den
   begripliga trädmodell som tidigare användes vid person- och
   fastighetsgranskningen: partner tydligt sida vid sida, barn under paret och
   biologisk släktgren konsekvent placerad. Det ska inte kräva manuella
   släktkretsar för att fungera. Översta led och synligt djup kan ändras utan
   att masterdata påverkas.
2. **Enkel personredigering.** Lägg till och ändra riktigt namn, namnperiod,
   livsstatus, födelse-/dödstid och kontext. Livsstatus ska kräva ett aktivt val
   när en ny person skapas. Spara ska skapa en ny V2-revision och ett kvitto.
3. **Enkel relationsredigering.** Partner/tidigare partner, förälder–barn och
   syskon ska kunna läggas till eller rättas. Bekräftad/ej bekräftad räcker som
   vardagsstatus.
4. **Navigation till personens sammanhang — byggt lokalt.** Visa länkar till de fastigheter,
   båtar, matrikeluppgifter, dokument och tävlingsresultat som faktiskt pekar
   på personens stabila ID. Sakuppgifterna redigeras fortfarande i ägarappen.
5. **Filter för verkliga kontrollbehov.** Visa personer med okänd livsstatus,
   markerad `needs_review`, ofullständiga relationer eller utan kontext när
   personen är extern.

### Bygg senare

- ”Hur är de släkt?” som en beräknad väg mellan två personer.
- Årsvy/tidsfilter för namn, relationer och fastighetsanknytning.
- En kompakt familjeakt när en stabil FAMILJ används som länk från en båt.
- Automatisk familjebildning ur partner och gemensamma barn, med möjlighet att
  korrigera undantag.

### Återinför inte

- familjer och släktkretsar som den första och dominerande huvudvyn;
- manuell administration av överlappande SLÄKT-grupper när samma presentation
  kan räknas ur personrelationerna;
- medlemsstatus som en andra master i personappen — den ägs av Matrikel;
- äldre UI-fält som `ui_clan`, generell generation eller kopierade fastighetsnamn.

**Målbild:** personlistan är den enkla ingången; personkortet visar närmaste
familj och länkar vidare till allt som berör personen, medan Släkter visar den
sammanhängande flergenerationsbilden.

## 2. Båtregister

### Dagens V2

Båtregistret har redan kort, sökning, kategori- och bildfilter, bilder,
grunduppgifter, ägarlänkar, aktiv tidslinje och en enkel V2-writer för båt,
händelse och bild. Äldre strukturerad data visas skrivskyddat som ett märkt
komplement.

### Återta eller bygg nu

1. **Begriplig källvisning.** Ersätt interna käll-ID:n med titel, dokumenttyp,
   år och en knapp till Dokumentarkivet eller källbilden. En källa får vara
   länkad till båten som helhet; den behöver inte kopplas till varje sakfält.
2. **Person-, familje- och släktfilter.** Återta möjligheten att börja med en
   person och se personens båtar samt vid behov välja FAMILJ eller SLÄKT. Den
   visade ägarparten ska alltid komma från Personmastern.
3. **Kompakt listläge.** Behåll bildkorten men återinför den lilla, täta
   registertabellen för snabb överblick och batchgranskning.
4. **Ren granskningsavslutning.** En `Se över`-fråga ska kunna avgöras som
   rättad, behållen eller irrelevant. Efter beslut ska gammalt resonemang inte
   fortsätta ligga som vardagsbrus.
5. **Tydliga historiska namn och ägare.** Namnbyte, registrering,
   avregistrering, köp, försäljning och belagd förekomst ska ligga i samma
   tidslinje med typ, tid och person/familj.

### Bygg senare

- Visa Korpholmen runt-resultat på båtkortet som en separat lässektion, aldrig
  som båthändelser.
- Visa dokument och matrikelutgåvor grupperade efter källtyp.
- Ett försiktigt verktyg för sammanslagning av verkliga dubblettbåtar.

### Återinför inte

- den stora ägargranskningens export/import- och batchpanel i vardagsappen;
- separata publika köer för specifikationsrättelser och ägarförslag;
- redigering av generation 1-komplementet;
- automatisk slutsats om ägande bara för att person och båt står på samma
  matrikelrad.

**Målbild:** Båtregistret är nästan färdigt som vardagsapp; nästa pass handlar
främst om källor, filter och att göra det äldre komplementet överflödigt genom
beslutad införsel.

## 3. Fastigheter

### Dagens V2

V2 har en kompakt fastighetstabell, filter, nuvarande ägare, strukturerad
tidslinje, personanknytningar och en writer för tidslinjeposter med tid,
händelsetyp, parter, roll, belopp, areal och kort granskningsnot.

### Återta eller bygg nu

1. **Fastighetsbildning och föregångare.** Återta den tydliga vyn för
   stamfastighet, avstyckning och efterföljande fastigheter. Den ska visa
   ordningen visuellt utan att kopiera hela stamfastighetens historia till
   varje avstyckad tomt.
2. **Grupperat samägande.** Samtidiga ägare ska visas på samma tidslinjerad när
   de hör till samma innehav eller överlåtelse.
3. **Fördjupning på begäran.** På en tidslinjerad ska man kunna fälla ut
   källor, råformulering, datumroll och eventuella alternativa belägg. Den
   normala tidslinjen förblir ren.
4. **Redigering av fastighetens struktur.** Lägg till/rätta föregångare,
   avstyckningsrelation, platslänk och grunduppgifter — inte bara händelser.
5. **Tydlig skillnad mellan ägande och anknytning.** Ägare/hyresgäst/brukare
   ligger i tidslinjen; `huvudsaklig fastighetsanknytning` och byggare ligger i
   ett separat, hopfällt avsnitt.

### Bygg senare

- Enkel kedjeöversikt per ö med fastighetsnummer, bildningstid och från vilken
  stamfastighet tomten skapades.
- Kartlänk till rätt objekt i Kartdata.
- Källjämförelse för de få fastigheter som har verkligt motsägande uppgifter.

### Återinför inte

- hela forskningsdatabasens claim-/evidensmodell i vardagsvyn;
- bred personkoppling som kan misstolkas som juridiskt ägande;
- flera samtidiga ”nuvarande ägare”-lager;
- historiska registerobservationer som automatiskt förvärvsdatum.

**Målbild:** den rena tidslinjen är huvudvyn; fastighetsbildning och källor
finns ett klick bort.

## 4. Dokumentarkiv

### Dagens V2

V2 kan visa överblick, handlingar, dokumentserier, samband, platser,
arbetskö och fulltextsökning. Hela avskriften och privata läskopior kan öppnas.
Vyn är skrivskyddad.

### Återta eller bygg nu

1. **Fullständig typ- och undertypsfiltrering.** Huvudkategorierna Möten,
   Ansökningar, Tävlingar, Klubbdokument och Övrigt ska ha sökbara undertyper,
   men gränssnittet ska börja enkelt.
2. **Dokumentpaket.** Huvudhandling, bilagor och flera sidor från samma möte
   eller tävling ska bläddras som ett dokumentpaket, inte som många lösryckta
   dokumentkort.
3. **Kompakta registerkopplingar överst.** Visa identifierade personer,
   båtar, fastigheter/platser, organisationer och utmärkelser grupperat och i
   liten stil. Klick öppnar en tät popup eller ägarappen.
4. **Roller som är roliga och begripliga.** Ordförande, sekreterare,
   kommittéer och pristagare ska visas strukturerat. Varje omnämnande behöver
   inte en dokumentteknisk roll som sökande, ombud eller undertecknare.
5. **Granskning i kontext.** I granskningsverktyget visas hela avskriften och
   markeringarna där de förekommer. Ett godkännande gäller den definierade
   dokumentlänken; samma person behöver inte godkännas för varje förekomst.
6. **Avskriftsversioner och rättning.** Återta jämförelsen mellan bevarade
   versioner. Markerade felläsningar ska kunna skickas till det lokala
   källverktyget, som skriver en ny Markdown-version och logg — inte direkt
   skriva över originalet i webbappen.

### Bygg senare

- Berättelsespår som grupperar ett ämne eller en tävling över flera dokument.
- Frågesökning med relevanta textutdrag och tydlig skillnad mellan textträff
  och strukturerad länk.
- Publiceringsflöde där godkänd klassning och godkända länkar blir nästa
  Dokumentmasterrevision.

### Återinför inte

- hyperlänk i varje namnform inne i avskriften;
- ett stort sambandsnät/spindelnät som huvudpresentation;
- gamla dokumentlänkar som blandas med de nya granskade länkarna;
- krav på avsändare, mottagare och detaljroll för varje omnämnd person;
- fri webbredigering av originalavskriften utan versionskopia.

**Målbild:** dokumentet står i centrum. Man ser snabbt vad det är, vilka som
nämns och vilka registerposter det hör till, och öppnar bara källapparaten när
den behövs.

## 5. Korpholmen runt

### Dagens V2

V2 har översikt, alla resultat, år för år, topptider, person-/båtprofiler,
Öduellen och en skrivskyddad lista över olösta person- och båtkopplingar.

### Återta eller bygg nu

1. **Källmaterial per tävlingsår.** Återta knappen för att visa det
   handskrivna originalet eller resultatdokumentet direkt på årssidan.
2. **Redigera ett resultat.** År, klass, bana, tid, båt och valfritt antal
   tävlande ska kunna rättas utan att råkällan ändras.
3. **En enkel V2-writer för nya resultat.** `Nytt resultat` ska spara en ny
   masterrevision och avvisa en gammal flik. Person och båt väljs alltid ur
   deras aktuella mastrar.
4. **Export och tydlig resultattabell.** Återta CSV-export och bibehåll
   sortering/filter som fungerar på strukturerad klass, bana, år, person och
   båt.
5. **Bättre granskningsunderlag.** Olösta namn grupperas efter sannolikhet och
   kan visa evidens från båtägande, tidigare tävlingar, familjemedlemmar och
   ålder. Inget förslag är förvalt som godkänt.

### Bygg senare

- Person- och båtprofiler med samtliga starter, bästa resultat och länkar till
  respektive master.
- Jämförelser över tid, klass och bana med samma regler som statistikmotorn.
- Dokumentlänk från tävlingsåret till dess samlade resultatpaket i
  Dokumentarkivet.

### Återinför inte

- AI-/heuristikmatchning som del av den vanliga resultatsidan;
- flera olika godkännandeknappar per förekomst;
- kapten-/besättningsroller som inte finns i källan;
- klassstandardisering eller råimport som en vardagsknapp för alla användare.

**Målbild:** resultatläsningen förblir enkel; rättning och nya resultat sker i
ett litet formulär; avancerad matchning ligger i ett separat granskningsläge.

## 6. Matrikel

### Dagens V2

Matrikeln är den mest funktionsfullständiga V2-appen. Den har Totalmatrikel,
historiska matrikelutgåvor med käll-/strukturväxling, Medlemsmatris,
Personhistorik och direkt redigering av medlemsnivå, klubbnamn, invalsår,
medlemsform, passivitet och uttryckligt avslutat medlemskap.

### Behåll och färdigställ nu

1. **Totalmatrikeln som vardagsvy.** Behåll filter för status, senior/junior,
   livsstatus, år, förekomst/saknas i viss utgåva och enkel medlemsredigering.
2. **Historisk källtrohet.** Behåll både ”Som källan skrevs” och den
   strukturerade matrikeln, med identiska kolumnbredder mellan år.
3. **Medlemsmatris och personhistorik.** Dessa ger den nödvändiga
   tidsöverblicken utan att historiska källrader skrivs om.
4. **Säkert flöde för ny matrikelutgåva.** En ny årsfil ska valideras,
   länkningsgranskas och publiceras som en ny revision utan att gamla utgåvor
   byggs om.

### Bygg senare

- **Klubbliv/personregister i KSSS-stil:** riktigt namn, tunt kursivt
  klubbnamn, invalsår samt kompakta rader för ordförandeskap, sekreterare,
  kommittéer, utmärkelser och båtar. Bör börja som egen vy eller tryckprodukt,
  inte belasta Totalmatrikeln.
- En personakt som sammanför matrikelhistorik, klubbroller och utmärkelser men
  länkar till Personer & familjer för släktskap.
- Källbild på begäran för de historiska matrikelutgåvorna.

### Återinför inte

- de borttagna sidorna Översikt och Förändringar;
- sidhänvisningar och långa källförklaringar på varje matrikelrad;
- månadsnummer som egen rubrik när året räcker i matrisen;
- familje- och släktvyer — de hör till Personer & familjer;
- båtägande härlett från tryckta kolumners placering.

**Målbild:** nuvarande Matrikel är basen. Nästa verkliga nyhet är en lätt och
rolig klubblivsvy, inte att återgå till gamla Klubbhistorik-appen.

## 7. Kartdata

### Dagens V2

V2 har en översikt, östruktur, skrivskyddad granskningskö och sorterbar tabell.
Den visar objekt, namnformer, plats och fastighet samt härleder aktuella ägare
från Fastigheter. Den saknar normal redigering.

### Återta eller bygg nu

1. **En enkel kartpost-editor.** Skapa och ändra namn, objektstyp, undertyp,
   nuvarande/historisk existens och kort not.
2. **Namnformer på samma objekt.** Föredraget, tidigare och alternativt namn
   ska kunna läggas till utan att skapa dubbla hus eller bryggor.
3. **Tydligt val av anknytningsnivå.** En post länkas till fastighet när det är
   mest precist och annars direkt till plats. Gränssnittet ska förklara valet,
   inte kräva dubbla länkar.
4. **Redigera platsstrukturen.** Plats och eventuell överordnad plats, som
   Yxlan → Brokholmen, ska kunna rättas utan att skapa en generell ny
   hierarkinivå för alla objekt.
5. **Säker borttagning och återställning.** Återta tombstone/ångra och visa
   vilka namn- eller fastighetslänkar som påverkas innan borttagning.
6. **Direktlänkar.** Fastighet, personägare och relaterade kartobjekt öppnas i
   rätt ägarapp; exakta `?entry=`- och `?place=`-länkar behålls.

### Bygg senare

- En riktig geografisk karta om tillräckligt många objekt får koordinater.
- Historiskt tidsfilter för objekt som inte längre finns.
- Enkel sammanslagningsfunktion för bekräftade dubblettposter.

### Återinför inte

- äldre AI-kommentarer och arbetsboksfält i vardagsmastern;
- kopierade ägarnamn eller en separat ägarmaster i Kartdata;
- automatisk ökoppling när fastigheten redan ger en säkrare anknytning;
- oklara typer som ”Plats/Ej byggnad”.

**Målbild:** samma rena V2-tabell, kompletterad med en liten editor och säkra
namn-/platsrelationer.

## 8. Explorer

### Dagens V2

Explorer söker i alla sju V2-mastrar och länkar direkt till ägarappen. Den har
ingen egen data och inga skrivfunktioner. Den äldre Explorer-vyn kunde även
sammanställa en personprofil.

### Återta eller bygg nu

1. **Samlad personakt.** När man öppnar en person ska Explorer visa identitet
   och länkar till medlemskap, familjerelationer, båtar, fastigheter,
   dokumentomnämnanden och Korpholmen runt-resultat. Varje faktum hämtas från
   sin ägarmaster.
2. **Grupperade sökträffar.** Samma sökning delas upp i personer, båtar,
   fastigheter, handlingar, tävlingsår och kartplatser så att textträffar inte
   ser ut som identitetslänkar.
3. **Sammanhang i träffen.** Visa varför posten matchade: klubbnamn,
   alternativt båtnamn, fastighetsnummer, dokumentutdrag eller rånamn i ett
   resultat.
4. **Tidsfilter.** Ett år eller intervall ska kunna begränsa historiska
   matrikelutgåvor, båthändelser, fastighetstidslinjer, dokument och resultat
   utan att förändra mastrarna.

### Bygg senare

- Motsvarande samlad akt för båt, fastighet och plats.
- ”Relaterat” som följer endast godkända strukturerade länkar.
- En liten familjegrupperad dokumentlista på personakten.

### Återinför inte

- någon writer eller egen sakmaster;
- kopierade profiler som kan bli inaktuella;
- automatiska länkar från enbart namnlikhet;
- ett stort relationsnät som blandar belagda länkar och textträffar.

**Målbild:** Explorer blir den enkla samlade läsvyn som många först trodde att
Matrikel skulle vara, men all redigering sker i rätt ägarapp.

## Rekommenderad byggordning

1. **Personer & familjer:** publicera den lokalt verifierade läsversionen och
   bygg därefter person-/relationseditorn som ett separat, säkert writer-byte.
2. **Dokumentarkiv:** typfilter, dokumentpaket, kompakta kopplingar och
   versionsspår. Detta stöder det fortsatta dokumentarbetet utan writer-byte.
3. **Kartdata:** enkel V2-editor för poster, namnformer och strukturlänkar.
4. **Korpholmen runt:** källbilder och enkel resultat-writer.
5. **Explorer:** samlad personakt när de föregående länkarna kan konsumeras.
6. **Fastigheter:** föregångar-/avstyckningsvy och källfördjupning.
7. **Båtregister:** källpresentation, kompakt läge och slutlig införsel av
   beslutad äldre struktur.
8. **Matrikel:** klubblivsvy/tryckprodukt och nytt utgåveflöde.

Ordningen betyder inte att de senare apparna är mindre viktiga. Den speglar
var V2 i dag har störst funktionellt glapp och vilka förbättringar som ger
andra appar bättre förutsättningar.

## Beslut före varje apppass

Innan kod flyttas eller skrivs om görs en kort tabell med den appens konkreta
V1-funktioner:

| Funktion | Ta tillbaka oförändrad | Bygg om i V2 | Ta inte tillbaka | Kommentar/motiv |
|---|---|---|---|---|

Simon behöver bara avgöra de verkliga vägvalen. Självklar teknisk anpassning,
testning och koppling till rätt V2-master görs utan att lägga över en
rad-för-rad-inventering på honom.
