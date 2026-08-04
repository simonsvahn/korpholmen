// Gemensam publik nyckel för Korpholmens appar. En app-hemlighet får aldrig
// läggas i klienten.
export const DROPBOX_CLIENT_ID = 'kcerqzo2kxxru3a';
export const DROPBOX_SCOPES = [
  'files.metadata.read',
  'files.content.read',
  'files.content.write'
];

// Finns bara i den lokala arbetskopian och kopieras aldrig till publicerad data.
export const LOCAL_BOOTSTRAP_URL = './privat/migrering-2026-08-01/initial-ops.json';
export const LOCAL_UI_METADATA_URL = './privat/migrering-2026-08-01/ui-metadata-ops.json';
export const LOCAL_APPROVED_DATA_URL = './privat/migrering-2026-08-01/approved-excel-ops.json';
export const LOCAL_FAMILY_MODEL_URL = './privat/familjemodell-2026-08-02.json';
export const LOCAL_EXTERNAL_PROPERTY_OWNERS_URL = './privat/korrigeringar/2026-08-04-externa-fastighetsagare.json';
