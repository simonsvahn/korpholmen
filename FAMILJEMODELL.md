# Arkitektur för personer, familjer, släkter och båtar

Matrikeln är master för personer och deras relationer. Båtregistret är master
för båtar och bilder. Fastighetshistoriken är master för fastigheter och
ägande. Apparna delar identiteter, men ingen app får skapa släktskap genom att
bara tolka ett efternamn, en fastighet eller ett båtnamn.

## Grundprincip: fakta, grupper och vyer

Modellen har tre lager:

1. **Fakta** är personer och bekräftade eller ej bekräftade personrelationer.
   Förälder–barn, syskon, partner och tidigare partner kan registreras direkt.
   En syskonrelation kräver inte att föräldrarna redan finns i materialet.
2. **Grupper** är beständiga familje- och släktskapsobjekt. De kan ha
   uttryckliga ankarpersoner och regler som »ankarna och deras efterkommande«.
3. **Vyer** räknas om från fakta och grupper: nära familj, släktväv,
   släktlinjer och fastighetsgemenskap. En härledd vy skriver aldrig tillbaka
   ett nytt bekräftat faktum.

## Två stabila gruppidentiteter

### FAMILJ

En `family-unit` är en konkret familjebildning kring en eller flera
ankarpersoner, exempelvis **Familjen Lena och Jan**. Samma person kan under
livet höra till flera familjer: som barn, partner och förälder. Skilsmässa
raderar inte familjen; partnerrelationen får i stället historisk status. En ny
partner kan ge en ny familjeenhet.

Standardregeln är `anchors_and_shared_children`: ankarpersonerna och endast
de barn som har en registrerad förälder–barn-relation till samtliga ankare.
Detta hindrar att barn från en tidigare eller senare relation automatiskt
läggs i fel familjebildning. Ett barn kan alltid läggas till uttryckligen när
källmaterialet är ofullständigt. Den äldre unionsregeln
`anchors_and_children` finns kvar för bakåtkompatibilitet men används inte för
nya familjer.

En uttryckligt tillagd person får inget automatiskt släktled. Släktled visas
bara när det finns en faktisk förälder–barn-kedja från gruppens ankare. Det
gör att ofullständiga uppgifter kan hållas synliga utan att appen hittar på
vilken generation personen tillhör.

En FAMILJ kan vara kopplad till flera SLÄKT samtidigt. Det behövs när två
släktgrenar möts, exempelvis genom ett par. Kopplingen placerar den konkreta
familjebildningen i båda grenarna men gör inte den ena partnerns övriga släkt
till medlemmar i den andra. Denna gräns är viktig: ett giftermål skapar en
korsfamilj, inte ett påstående om att hela släkterna är samma grupp.

Den läsbara koden är `FAMILJ-001`, `FAMILJ-002` och så vidare.

### SLÄKT

En `kin-group` är en namngiven släktskapsgrupp. Fältet `kind` skiljer mellan:

- `syskongrupp` — uttryckliga syskon även när deras föräldrar saknas;
- `släktgren` — en namngiven gren som kan korsa efternamn;
- `stamlinje` — efterkommande till angivna ankarpersoner eller en ankarfamilj;
- `släktkrets` — ett bredare paraply av personer och undergrupper.

Den läsbara koden är `SLÄKT-001`, `SLÄKT-002` och så vidare. Typen ligger i
ett eget fält och kan beskrivas bättre senare utan att identiteten ändras.

## Identitet och läsbarhet

Varje grupp har tre skilda värden:

```text
internt id:     osynligt, globalt unikt och synksäkert
referenskod:    SLÄKT-001
visningsnamn:   Bröderna Hedström
```

I Excel och länkar kan kod och namn kombineras:

```text
SLÄKT-001--bröderna-hedström
```

Endast det interna id:t bär den tekniska identiteten. Referenskoden låses när
posten har synkats första gången och återanvänds aldrig. Visningsnamn och den
läsliga namnsvansen kan ändras utan att länkar till gruppen bryts. Tre siffror
är en läsbar start; serien fortsätter naturligt med `FAMILJ-1000` om det någon
gång skulle behövas.

## Bekräftelse utan källbrus

I apparnas vardagsdata finns två saklägen:

- **bekräftad**;
- **ej bekräftad**.

Statusen hör till varje personrelation, grupp och båtkoppling. Källhänvisning
är frivillig forskningsmetadata och används bara när ett verkligt dokument,
fotografi eller en intervju behöver anges. Formuleringar som »chatt med
Simon« ska inte visas eller krävas i sakregistret. Den tekniska
ändringshistoriken och tombstones finns ändå kvar och hindrar en borttagen
feluppgift från att återuppstå vid synkning.

## Släktled är alltid relativa

Det finns ingen gemensam generation 1, 2 eller 3 för hela Korpholmen. Ett
släktled lagras eller räknas i relation till en bestämd grupp:

```text
person: Svante Svahn
släkt: Carl-Gunder och Bibbis stamlinje
släktled: 5
```

Samma person kan ha ett annat släktled i en annan linje. Appen ska därför
skriva »femte släktledet efter Carl-Gunder och Bibbi«, aldrig bara
»generation 5«. Det äldre ensamma personfältet `ui_generation` får endast
användas som övergångsdata för layout och ska inte presenteras som jämförbar
sakdata.

Skilda familjer jämförs i stället genom kalender och öhistoria: första
öanknytning, verksamhetsperiod, fastighet, antal år på ön och antal
öanknutna släktled. En nyinflyttad familj är först en `FAMILJ`. Om dess
efterkommande åttio år senare motiverar en stamlinje skapas en ny `SLÄKT` som
pekar på den ursprungliga familjen; den jämförs inte numeriskt med äldre
släkter.

## Båtkopplingar

En båt kan kopplas till:

- en person;
- en `FAMILJ`;
- en `SLÄKT`;
- en fastighet.

Kopplingen har en betydelse, exempelvis `ägdes av`, `användes av`, `byggdes
av` eller `förknippas med`. Om båten kopplas till en hög grupp visas den även
i undergrupper och hos gruppens personer, men med texten »via …«. Ärftlig
synlighet är inte detsamma som personligt ägande.

**Bröderna Hedström** kan därför vara en bekräftad syskongrupp med
Carl-Gunder och Nils-Henrik som ankarpersoner trots att deras föräldrar saknas.
En båt kan kopplas direkt till den gruppen. Om gruppens regel omfattar
efterkommande blir båten navigerbar i båda grenarna utan att appen påstår att
varje efterkommande har ägt den.

## Hedström som första strukturerade exempel

```text
SLÄKT-001  Bröderna Hedström                    syskongrupp
SLÄKT-002  Carl-Gunder och Bibbis efterkommande stamlinje
SLÄKT-003  Nils-Henrik och Ilses efterkommande  stamlinje
SLÄKT-004  Görvel–Åkerman                       släktgren
SLÄKT-005  Inger–Bethge                         släktgren
SLÄKT-006  Lena–Böving                          släktgren
SLÄKT-007  Johan–Hedström/Freivalds             släktgren
SLÄKT-008  Kerstin–Hagström                     släktgren
SLÄKT-009  Thomas–Hedström                      släktgren

FAMILJ-001 Carl-Gunder och Bibbi
FAMILJ-002 Nils-Henrik och Ilse
FAMILJ-003 Görvel och Petter
FAMILJ-004 Inger och Per Olof
FAMILJ-005 Lena och Jan
FAMILJ-006 Johan och Kerstin
FAMILJ-007 Johan och Laila
FAMILJ-008 Kerstin och Calle
FAMILJ-009 Thomas och Solveig
```

Strukturen får finnas som ej bekräftad utan att de underliggande
personrelationerna uppgraderas. I den första migreringen är endast sådant
Simon uttryckligen har bekräftat markerat som bekräftat.

## Den fullständiga modellen och fortsatt utbyggnad

Den första totalmodellen omfattar alla familjebildningar som kan identifieras
utan nya personpåståenden: registrerade partner/tidigare partner samt grupper
av två eller fler registrerade medföräldrar. Modellen utökar de nio första
Hedström-familjerna och de nio första släktgrupperna; den ersätter eller
numrerar aldrig om dem.

De äldre personfälten `ui_clan` och `family` används bara som ett
övergångsunderlag för att fånga personer som ännu saknar kompletta
relationer. Meningsfulla äldre namn sparas som sökord på en stabil SLÄKT.
En äldre klanetikett får aldrig ensam dra in en hel familjegren under en annan
SLÄKT bara för att en person har gift in sig där. Strukturerade gruppkopplingar
och uttryckliga personrelationer har företräde framför sådana etiketter.
Statusrubriker som »utan känd släktkoppling« skapar ingen släktgrupp. De äldre
etiketterna visas inte som ett parallellt val i apparna och kan avvecklas när
alla personer är täckta av relationer eller uttryckligt medlemskap.

Verktyget `apps/personer-familjer/verktyg/utoka-familjemodell.mjs` är återkörbart mot
den aktuella operationsmastern. Det matchar en familj via dess oföränderliga
ankaruppsättning, behåller befintligt id, kod, namn och bekräftelsestatus och
skapar endast saknade grupper eller medlemskap. Varje senare körning får ett
nytt migrerings-id. Därmed kan datan kompletteras i flera omgångar utan att
båtkopplingar, länkar eller äldre hänvisningar bryts.

Efter korrigeringspasset 2026-08-02 ger den aktuella datan 49 FAMILJ och 25
SLÄKT. Den nya fristående gruppen är `SLÄKT-025 · Näsmark–Ekström–Berlin`.
Familjen Hanna och Erik är kopplad både till Görvel–Åkerman och till
Näsmark–Ekström–Berlin; detta är modellens första uttryckliga korsfamilj.
Det är en modell av vad som finns registrerat nu, inte ett påstående om att
materialet är slutgiltigt. Ej bekräftade relationer ger ej bekräftade
familjebildningar och kan rättas eller tas bort med bevarad ändringshistorik.

## Ansvar mellan apparna

- **Matrikeln** äger personer, personrelationer, `FAMILJ`, `SLÄKT`,
  bekräftelsestatus och medlemskap. Den behåller ett navigationslager för
  fastighetsgemenskap men är inte master för juridiskt ägande.
- **Båtregistret** äger båtar, motorer, bilder, båthistorik och typade länkar
  till Matrikelns stabila id:n.
- **Fastighetshistoriken** äger fastigheter, historiska jordenheter,
  kadastrala relationer, ägande, bruk, transaktioner, datum och evidens. En
  fastighetsgemenskap i Matrikeln är aldrig i sig bevis för lagfart.

Alla tre apparna fortsätter använda oföränderliga operationer, lokal
IndexedDB, Dropbox-synk och tombstones. Privat person- och gruppdata får aldrig
byggas in i GitHub Pages-paketet.
