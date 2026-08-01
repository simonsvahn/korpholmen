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

Repo-roten är OAuth-retur och appväljare. Privat data finns aldrig i GitHub.
