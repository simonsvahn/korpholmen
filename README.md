# Korpholmen

Gemensamt, datafritt repo för Korpholmens appar. Dropbox-projektmappen är den
permanenta Git-checkouten. Privat masterdata ligger bredvid koden i ignorerade
appmappar eller i Korpholmens privata Dropbox App Folder och publiceras aldrig
till GitHub.

- `apps/matrikel/` — källkod och privata, ignorerade arbetsdata för personer,
  relationer, klubbnamn och familje-/fastighetsgemenskap.
- `apps/batregister/` — källkod och privata, ignorerade arbetsdata för båtar,
  bilder och länkar till Matrikelns person-ID.
- `apps/fastigheter/` — källkod och privat master för registerenheter,
  historiska jordlotter, ägande, bruk, transaktioner och källbelägg.
- `apps/dokumentarkiv/` — källkod och privat operationsmaster för ordagranna,
  sökbara avskrifter och granskade registerkopplingar.
- `apps/korpholmenrunt/` — källkod, privat resultatsmaster och granskade länkar
  till Matrikelns person-ID och Båtregistrets båt-ID.
- `apps/klubbhistorik/` — källkod och privat, tidsbunden observationsmaster
  för matrikelutgåvor, medlemsstatus, klubbnamn och båtförekomster.
- `packages/core/` — gemensam datafri motor för operationer, IndexedDB,
  Dropbox-synk och OAuth.
- `matrikel/`, `batregister/`, `fastigheter/`, `dokumentarkiv/`,
  `korpholmenrunt/`, `klubbhistorik/` och `kartdata/` — datafria
  publiceringspaket för GitHub Pages.

Den gemensamma begrepps- och ansvarsfördelningen för nära familj,
familjegren, släktkrets och fastighetsgemenskap finns i
[`FAMILJEMODELL.md`](FAMILJEMODELL.md).

Den normerande ansvarskartan, dataflödena och skisserna för hela appfamiljen
finns i [`ARKITEKTUR.md`](ARKITEKTUR.md). Apparnas README-filer beskriver
drift och aktuellt dataläge; arkitekturdokumentet beskriver den avsedda
helheten och gränserna mellan mastrarna.

Den avsedda katalogstrukturen och gränsen mellan aktuell kod, privat data och
arkiv beskrivs i [`PROJEKTSTRUKTUR.md`](PROJEKTSTRUKTUR.md). En kort tabell över
vilka generation 2-mastrar som är skrivande respektive skrivskyddade finns i
[`STATUS.md`](STATUS.md).

Repo-roten är den enda installerbara PWA:n **Korpholmen**, gemensam OAuth-retur,
appväljare och synkcentral. Rotmanifestet har scope över hela appfamiljen. Alla
underappar länkar till samma manifest och registrerar samma service worker, så
navigationen stannar i en installerad app på bland annat iPhone. Privat data
finns aldrig i GitHub.

Generation 2 använder den enkla modell som valts för vardagsarbetet: en
mänskligt läsbar masterfil per ägarapp, en liten aktiv pekare och ett separat
oföränderligt ändringskvitto per sparning. En sparning skapar alltid en ny
masterrevision. Revisionskontroll avvisar en gammal flik eller enhet i stället
för att tyst skriva över nyare data. Generation 1:s operationsloggar,
checkpoints och snapshots bevaras som historiskt arkiv under övergången och är
fortsatt writer endast för appar vars generation 2 ännu är skrivskyddad.

Apparna använder fortfarande lokal IndexedDB för snabb start och offlinevy.
Båtregister lagrar dessutom privata bilder lokalt. Ingen privat master eller
bild byggs in i GitHub Pages.

Bygg hela appfamiljen och det gemensamma release-manifestet med `npm run build`.
Kontrollera därefter samtliga data- och PWA-kontrakt med `npm test`.
