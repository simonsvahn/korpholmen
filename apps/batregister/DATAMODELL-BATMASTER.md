# Datamodell för Båtmaster

Båtregistret skiljer mellan **båten**, **källobservationerna** och den
redigerbara sammanfattningen. En källa får aldrig skrivas om till en säkrare
uppgift än vad originalet faktiskt säger.

## Entiteter

| Entitet | Ansvar |
|---|---|
| `boat` | Stabil båtidentitet och den korta sammanfattning som listvyn använder. |
| `boat-source` | Originalkälla med källtyp, relativ sökväg eller länkad master och kontrollsumma. |
| `boat-name-observation` | Ett namn som faktiskt förekommer i en källa. Anger om det är använt namn, historiskt namn, stavningsvariant eller bara namnförslag. |
| `boat-ownership-observation` | Ägaruppgift för person, stabil `family-unit` eller en uttryckligen namngiven persongrupp. Tidsuppgift och osäkerhet hör till observationen. |
| `boat-spec-observation` | Bara de specifikationer som källan faktiskt innehåller, exempelvis längd, motorfabrikat eller hästkrafter. |
| `boat-event-observation` | Registrering, avgång, försäljning, namnbyte eller annan daterad/odaterad händelse. Ett dokumentår får inte automatiskt bli händelseår. |
| `boat-review-item` | En avgränsad fråga som inte får lösas automatiskt. |
| `boat-pilot-manifest` | Pilotens omfattning, modellversion och återställningsuppgifter. |

Observationerna lagras med ett strukturerat `record`-fält. Det gör en hel
observation atomisk och håller en pilotbatch liten nog att skrivas som en enda
oföränderlig operationsfil.

## Ägare

`party_type` är en av:

- `person` — en uttryckligen namngiven person;
- `family-unit` — en stabil FAMILJ från Matrikelns master;
- `kin-group` — en stabil SLÄKT från Matrikelns master när källan uttryckligen
  anger en större släktkrets och inte ett enskilt hushåll;
- `person-set` — flera uttryckligen namngivna ägare som inte utgör en enda
  familjeenhet.

Juridiskt ägande modelleras inte. Rollen är klubb- och källhistorisk
`owner`. Vaga uppgifter om bruk eller anknytning sparas som granskningsfrågor,
inte som ägande.

## Namn

Berättelser, matriklar, registerblad och Korpholmen runt kan belägga använda
namn. Ansökningar och protokoll kan innehålla förslag och skämt; sådana får
typen `proposal` och kan aldrig ensamma bli båtens huvudnamn.

Ett verkligt namnbyte skapar inte en ny båt. Det gamla och det nya namnet
ligger som två `boat-name-observation` med strukturerade start-/slutår. Om
namnbytet sker vid ett ägarbyte får namnposterna, ägarposterna och de två
händelserna samma `transition_id`. Därmed går de att visa som en gemensam
övergång utan att blanda ihop namnhistorik och ägarhistorik.

Två skilda båtar får ha samma huvudnamn. Då används en neutral
visningsurskiljning, exempelvis `Snusmumriken · segelbåt` och
`Snusmumriken · kajak`. Romerska ordningsnummer skapas inte av systemet; I/II
är namn bara när de faktiskt har använts eller uttryckligen beslutats av
Simon. Ett objekts stabila ID ändras inte när namnet blir känt eller byts.

## Specifikationer

Strukturerade fält skapas bara när uppgiften finns. I gränssnittet visas därför
inte tomma motor- eller måttfält. Motorfabrikat och hästkrafter är separata
fält. Källans ordalydelse ligger separat i `source_values`, och osäkerhet eller
ungefärlighet i `qualifiers`; en uppgift som »100/115 hkr« får alltså inte
godtyckligt bli ett enda numeriskt värde. Två registerkort med olika mått blir
två observationer och markeras diskret som avvikande i läsvyn.

Ett OCR-, avskrifts- eller läsfel är **inte** en källuppgift. När originalet
kontrolleras rättas därför samma källobservation. Det fellästa värdet ska inte
finnas kvar som konkurrerande sakdata eller visas som en motsägelse; den
append-only tekniska revisionsloggen räcker för att åtgärden ska kunna
granskas och återställas.

En ny observation med `status: accepted`, `resolves_fields` och
`accepted_at` används bara när den nya uppgiften verkligen är en annan
uppgift: exempelvis ett motorbyte, en senare mätning eller två självständiga
källor som faktiskt säger olika saker. Då bevaras båda källobservationerna.

Återkommande uppgifter kan dessutom lagras som bland annat vikt,
fribord, drivmedel, färg och framdrivning. Kategorilistan är utbyggbar och
omfattar även exempelvis surfbrädor och kitesurfbrädor. Modellbeteckning kan
bevaras i källtext men görs inte till ett krav.

Ett helt äldre registerkort importeras som en sammanhållen källgrupp: specifikation,
material, vikt och uttryckliga båthändelser följer med när de finns. Fältet
»Lev« tolkas som leverans, inte digitaliseringsdatum. »Inköpt« eller en
uttrycklig gåva blir en båthändelse men ersätter inte en separat, strukturerad
ägarobservation.

## Läsning och redigering

Båtprofilen öppnas alltid i ett rent läsläge. Där visas bara namn, bild,
strukturerad ägarhistorik, specifikation och händelser. Person- och
familjenamn länkar med stabila ID:n till Matrikeln. Källor och pågående
källutredningar ligger hopfällda under `Källor`.

Ägarnamn löses vid varje läsning från det stabila person-, familje- eller
släkt-ID:t i Matrikelns aktuella master. Det lagrade `party_label` är bara en
reserv om den länkade mastern tillfälligt inte kan läsas. Det äldre
fritextfältet `boat.agare` visas aldrig som ägarfakta och får inte vinna över
en strukturerad koppling; det bevaras endast dolt i redigerings- och
migreringsunderlaget tills uppgiften har källkontrollerats.

Redigeringsfält, person-/familjekopplingar, bilduppladdning och borttagning
visas först efter ett aktivt val av `Redigera`. Ägarens tidsuppgift lagras i
`boat-ownership-observation` med separat årtal och precision, exempelvis
`not_later_than` för visningen »belagd senast 1976«. Ett uttryckligt start- och
slutår visas som en ägarperiod. Kopplingsposterna används för sökning och
gruppering men dubbleras inte som en andra ägarlista i läsläget.

I pilotläget sparas ändringar i strukturerade specifikationsfält som lokala
granskningsbeslut. Beslutet bär en exakt före-bild och kan märkas
`draft` eller `ready`; bara färdiga beslut kommer med i den nedladdningsbara
specifikationskön. Varje ändrat fält anger om åtgärden är `correct-source`
(rätta exakt en felläst källpost) eller `add-fact` (komplettera ett tomt fält).
Om flera källobservationer redan innehåller fältet stoppas den enkla
rättningen och måste källgranskas. Kön ändrar aldrig Dropbox-mastern
automatiskt och ska införas med samma före-värdeskontroll och append-only-
princip som övriga pilotbatcher.

Person- och familjefiltren härleder ägarkopplingar direkt från
`boat-ownership-observation`. Separata `boat-person-link` och
`boat-group-link` används bara för andra relationer eller äldre data; en ny
ägarregistrering skapar därför inte längre en parallell kopplingspost.

En `person-set` behåller ett separat stabilt person-ID per namngiven delägare.
Den är alltså inte en sammanslagen person och inte heller automatiskt en
`family-unit`. I läsvyn löses varje ID mot Matrikeln och visas som en egen
klickbar person. En familjekoppling används bara när källan faktiskt anger
familjen som ägande part eller när det finns en separat, granskad grund för
den tolkningen.

Samägande och ägarföljd är två olika strukturer. Samtidiga, uttryckligt
namngivna delägare ligger i **en** `person-set`. Ett ägarbyte blir i stället
**två** `boat-ownership-observation`, en per ägarpart. Varje post har ett
positivt `sequence` som bevarar den källtolkade kedjeordningen även när årtal
saknas. Start- och slutår används bara när de är belagda; ordningsföljden får
aldrig omvandlas till påhittade datum.

När två källobservationer innehåller olika värden för samma specifikationsfält
visar läsläget bara den diskreta markeringen »Uppgifter skiljer sig«.
Värdena och utredningen bevaras under `Källor`; de skrivs inte över.

## Pilot och återställning

Verktyget `verktyg/genomfor-batmaster-pilot.mjs`:

1. materialiserar den skarpa privata Dropbox-mastern;
2. kontrollerar alla förväntade före-värden och externa person-/familje-ID:n;
3. hashar varje lokal originalkälla;
4. skapar högst en oföränderlig operationsbatch;
5. sparar plan, före-/efterbild och operationer i pilotens privata revisionsmapp.

`verktyg/aterstall-batmaster-pilot.mjs` vägrar återställning om någon av
pilotens entiteter har ändrats efteråt. En återställning är också append-only:
den skriver nya reset-/restore-/tombstone-operationer och raderar aldrig
historiken.

`verktyg/verifiera-batmaster-pilot.mjs` gör en fristående efterkontroll av
operationsbatch, revisionsbild, källhashar, entitetsantal och pilotens
semantiska nyckelregler. Originalplanen kan anges separat så att även dess
råa filkontrollsumma verifieras.

Ett piloturval som får nya uttryckliga uppgifter skrivs som ett nytt manifest
med `supersedes`; det gamla revisionskvittot ändras aldrig. Gränssnittet visar
bara den senaste versionen och leder äldre pilotlänkar vidare till den.

En stor källinventering delas i flera efterföljande pilotbatcher. Varje batch
har egen plan, källhashar, före-/efterbild och återställningsgräns. Den senaste
manifestversionen kan omfatta samtliga tidigare båtar utan att deras gamla
revisionsfiler skrivs om. Verifieraren materialiserar äldre batchers
entitetsantal vid respektive batchtidpunkt och kontrollerar samtidigt att dess
berörda entiteter fortfarande är oförändrade i dagens master.

Den privata pilotplanen och revisionsmaterialet ligger inte i Git. Appskalet
på GitHub är fortsatt helt datafritt.

### Ägargranskning i lokal pilot

Pilotens ägargranskning läser den privata `agarinventering.json` som en
arbetskö. Den visar båtar med äldre ägarfritext och lägger granskningsbesluten i
ett separat lokalt dokument i IndexedDB. Varken inventeringsfilen eller
Båtmastern ändras när ett beslut sparas. Beslutsdokumentet kan säkerhetskopieras
och återimporteras som JSON.

Inventering version 2 har dessutom `structured_review_rows`: redan införda
ägarposter som kan vara en felaktig sammanblandning av samägande och
ägarföljd, möjliga dubbletter eller ofullständiga ägarparter. Ett sådant beslut
har läget `replace` och bär en exakt `expected_ownerships`-före-bild. Den
kontrollerade ändringskön vägrar rättningen om mastern har ändrats sedan
underlaget byggdes.

Ett beslut har status `draft`, `needs_research` eller `ready`. Varje ägarpost
har den strukturerade rollen `owner`, en part, en tidsuppgift med precision och
en eller flera strukturerade källor. Flera uttryckligen namngivna personer
sparas som `person-set` med ett separat person-ID per person; de slås aldrig
ihop till en påhittad familj. Familj eller släkt får väljas bara som en egen
stabil part från Matrikelmastern.

Kandidaterna i inventeringen är förslag och godkänns aldrig automatiskt.
Piloten döljer Båtregistrets vanliga direktredigering: den enda skrivytan är
granskningsbeslutet. Ett beslut kan sparas som utkast eller utredning utan
källa, men statusen `ready` kräver minst en ägarpost och minst en strukturerad
källa per post som uttryckligen är klassad som belägg för ägande. En bild- eller
namnkälla kan därför inte ensam föra ett ägarbeslut till mastern.

En person, familj eller släkt som är vald i formuläret följer automatiskt med
när beslutet sparas. Knappen **Lägg till nästa ägare** används när samma beslut
ska innehålla flera ägarperioder eller en odaterad ägarföljd.

I gränssnittet heter de två avsikterna uttryckligen **Lägg till nästa ägare**
och **Lägg till som samägare**. Den första skapar en ny observation med nästa
`sequence`; den andra skapar en `person-set` inom samma observation. Flera
personkandidater kombineras aldrig automatiskt.

Ungefärliga äldre startår lagras med precisionen `circa`. Att en kedjeordning
är känd kräver däremot inget årtal: `sequence` räcker, och appen får inte fylla
luckan med ett antaget datum.

Granskningsvyn visar källans faktiska lokala visningskopia. PDF och bilder
visas direkt; textkällor visar hela avskriften. När både originalfoto,
läsbild och avskrift finns ligger de som separata flikar för samma källpost.
Visningskopiorna byggs av `verktyg/bygg-kallvisning.mjs`, kontrolleras med
SHA-256 och ligger enbart i den ignorerade privata pilotmappen. Originalen i
källrötterna ändras aldrig och publiceringspaketet innehåller inga källfiler.

En entydig filnamnsmatch mellan ett äldre Båtar 2-registerblad och en båt kan
visas som en föreslagen `boat-source`. Flera möjliga filer visas uttryckligen
som kandidater och får inte användas som ägarbelägg. Om en föreslagen källa
används följer hela källposten med i ändringskön; planbyggaren skapar då
källposten och ägarobservationen atomiskt efter ny hashkontroll.

**Batchläget** markerar flera båtar men skapar ett separat `draft`-beslut och
en separat `boat-ownership-observation` per båt. Besluten binds ihop med ett
gemensamt `batch_id`, medan äldre ägartext, källa och förslags-ID förblir
båtspecifika. Båtar som redan har en ägarpost kan inte skrivas över i batch.
Om en båt har exakt en ägarkälla väljs den i formuläret; flera källor kräver
ett val och saknad källa ger ett utkast som måste granskas vidare.

Knappen **Hämta ändringskö** exporterar bara `ready`-beslut. Nya ägarposter får
inte redan finnas i mastern; korrigeringar måste i stället ha en exakt
före-bild. Exporten förändrar ingen master. Den kontrollerade vägen vidare är
tvåstegad. Köformat version 3 innehåller dessutom de fullständiga
källposter som de exporterade besluten refererar till:

```sh
node apps/batregister/verktyg/bygg-agarkoplan.mjs \
  "/sökväg/till/batregister-agarkoe-ÅÅÅÅ-MM-DD.json" \
  "/Users/simon/Dropbox/Appar/Korpholmen/batregister/ops" \
  "/Users/simon/Dropbox/Appar/Korpholmen/matrikel/ops" \
  "/private/tmp/batregister-agarkoplan.json"

node apps/batregister/verktyg/genomfor-batmaster-pilot.mjs \
  "/private/tmp/batregister-agarkoplan.json" \
  "/Users/simon/Dropbox/Appar/Korpholmen" \
  "/Users/simon/Dropbox/AI/Projekt/2 Wikis & källor/Wiki Korpholmen & släkten"
```

Det andra kommandot är alltid en torrkörning. Först efter manuell kontroll får
samma kommando köras med `--write`. Planbyggaren kontrollerar att båtens gamla
ägartext är oförändrad, att alla källor fortfarande finns och hör till båten,
att alla länkade person-/familje-/släkt-ID:n finns i Matrikelmastern och att
rollen verkligen är `owner`. Vid en rättning tombstonas de exakt matchande
gamla observationerna och ersätts av de granskade posterna i samma append-only-
batch. Det befintliga pilotverktyget skriver därefter ett revisionskvitto med
före-/efterbild; ingenting skrivs över eller raderas ur historiken.

Efter en införd batch byggs den lokala förhandsvisningen om. Båtar som då har
strukturerat ägande visas som `applied` och faller ur nästa ändringskö; det
tidigare granskningsbeslutet kan ligga kvar som lokalt arbetskvitto.

Den lokala pilotbyggaren skapar dessutom en privat, skrivskyddad snapshot av
Matrikelns personer och familjegrupper. Den gör att flerpersonsägande visas som
individuella personer även i en ny lokal webbläsare utan Dropbox-session. I
den publicerade appen kommer samma namn och länkar från den skrivskyddade
Matrikelmastern vid synk. Att enbart publicera appskalet skapar eller godkänner
inga ägaruppgifter.
