# Korpholmen

Gemensamt repo och gemensam Dropbox App Folder för flera separata appar.
Dropbox-projektmappen är den permanenta Git-checkouten och har samma struktur
som GitHub.

- `apps/matrikel/` — källkod och privata, ignorerade arbetsdata för personer,
  relationer, fastigheter, klubbnamn och öar.
- `apps/batregister/` — källkod och privata, ignorerade arbetsdata för båtar,
  bilder och länkar till Matrikelns person-ID.
- `packages/core/` — gemensam datafri motor för operationer, IndexedDB,
  Dropbox-synk och OAuth.
- `matrikel/` och `batregister/` — datafria publiceringspaket för GitHub Pages.

Den gemensamma begrepps- och ansvarsfördelningen för nära familj,
familjegren, släktkrets och fastighetsgemenskap finns i
[`FAMILJEMODELL.md`](FAMILJEMODELL.md).

Repo-roten är OAuth-retur och appväljare. Privat data finns aldrig i GitHub.

Båda apparna är PWA:er med cache-först-appskal. Efter första lyckade
Dropbox-synken startar de från lokal IndexedDB utan nät, sparar ändringar
lokalt och skickar dem automatiskt när anslutningen återkommer. Båtregister
lagrar även hela det hämtade bildbeståndet lokalt och köar nya offlinebilder.
