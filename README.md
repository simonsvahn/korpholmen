# Korpholmen

Gemensamt repo och gemensam Dropbox App Folder för flera separata appar.
Dropbox-projektmappen är den permanenta Git-checkouten och har samma struktur
som GitHub.

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

Repo-roten är den enda installerbara PWA:n **Korpholmen**, gemensam OAuth-retur,
appväljare och synkcentral. Rotmanifestet har scope över hela appfamiljen. Alla
underappar länkar till samma manifest och registrerar samma service worker, så
navigationen stannar i en installerad app på bland annat iPhone. Privat data
finns aldrig i GitHub.

Korpholmen har ett gemensamt versionsatt, datafritt appskal. De sju
sakapparna har fortfarande varsin IndexedDB och Dropbox-namnrymd. Efter första
lyckade Dropbox-synken startar de från lokal IndexedDB utan nät, sparar
ändringar lokalt och skickar dem automatiskt när anslutningen återkommer.
En gemensam Dropbox-session återanvänds av alla appar. När en app öppnas drar
bakgrundssynken nya operationer till de övriga lokala mastrarna; bara den
aktiva ägarappen laddar upp sina väntande ändringar. Båtregister lagrar även
hela det hämtade bildbeståndet lokalt och köar nya offlinebilder.

Bygg hela appfamiljen och det gemensamma release-manifestet med `npm run build`.
Kontrollera därefter samtliga data- och PWA-kontrakt med `npm test`.
