// Den publika nyckeln fylls i först när en separat Dropbox-app med App Folder
// har skapats för Släktlandskap. En app-hemlighet får aldrig läggas här.
export const DROPBOX_CLIENT_ID = 'kcerqzo2kxxru3a';
export const DROPBOX_SCOPES = [
  'files.metadata.read',
  'files.content.read',
  'files.content.write'
];

// Finns bara i den lokala arbetskopian och kopieras aldrig till publicerad data.
export const LOCAL_BOOTSTRAP_URL = './privat/migrering-2026-08-01/initial-ops.json';
export const LOCAL_UI_METADATA_URL = './privat/migrering-2026-08-01/ui-metadata-ops.json';
