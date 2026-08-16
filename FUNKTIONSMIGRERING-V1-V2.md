# Funktionsmigrering från V1 till V2

Detta dokument skyddar tidigare appfunktionalitet under förenklingen av V2.
Målet är inte att V2 ska efterlikna V1 i detalj, utan att ingenting av värde
försvinner utan ett uttryckligt beslut.

## Säker referenspunkt

Git-taggen `v1-ui-before-v2-cutover-2026-08-16` pekar på commit `c8fabc7`, den
sista kompletta kodpunkten före den breda kopplingen av appfamiljen till de
aktiva V2-mastrarna. Där finns de tidigare appvyerna och funktionerna kvar.

Privat masterdata återställs inte från denna Git-tagg. Den skyddas av de
separata fullbackuperna och de frysta generation 1-loggarna som anges i
`STATUS.md`.

## Regel för fortsatt ombyggnad

Innan en äldre funktion tas bort eller ersätts ska den klassas som en av:

1. **Behåll** — behövs i V2 och ska fungera mot den nya mastern.
2. **Bygg om** — behovet finns kvar men gränssnittet eller arbetsflödet ska
   förenklas.
3. **Gallra** — funktionen saknar värde och får tas bort efter Simons beslut.

Synlig funktionalitet gallras aldrig enbart därför att den första V2-vyn är
enklare. Varje V2-app får börja med en enkel läsvy, men V1 är fortsatt
funktionsreferens tills genomgången av appen är beslutad.

## Så återtas en äldre funktion

1. Jämför den berörda appen mot taggen, inte hela projektet på en gång:

   `git diff v1-ui-before-v2-cutover-2026-08-16..main -- apps/APPNAMN`

2. Identifiera själva användarbehovet och vilka V1-filer som bar funktionen.
3. Flytta eller bygg om funktionen i den nuvarande V2-läsaren/writern så att
   den använder stabila V2-ID:n och rätt ägarmaster.
4. Lägg till ett kontraktstest och prova med verklig privat V2-data.
5. Publicera först när funktionen inte kan skriva till fel generation.

En gammal appfil ska alltså inte kopieras tillbaka blint. Det kan återinföra
V1:s datalager, gamla Dropbox-sökvägar eller en writer som inte längre äger
sakuppgiften.

## Nödläge

Om ett nytt appskal blir oanvändbart kan den äldre koden öppnas eller byggas på
en separat återställningsgren från taggen för jämförelse. Den ska då vara
skrivskyddad tills det är verifierat vilken master den läser. Dagens aktiva
masterpekare ändras inte som en del av en sådan UI-återställning.

Det ger två oberoende skydd:

- Git-taggen bevarar den tidigare funktionaliteten.
- Fullbackuper och frysta generationsspår bevarar datan.

Den appvisa rekommendationen och föreslagen byggordning finns i
`FUNKTIONSREKOMMENDATION-V1-TILL-V2.md`.
