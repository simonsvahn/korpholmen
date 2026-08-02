import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PROJEKT = resolve(REPO, '../../..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-02');
const DEVICE = 'migration-dokumentarkiv-2026-08-02';
const CLOCK_MS = Date.UTC(2026, 7, 2, 18, 0, 0);

async function childByNfc(parent, wanted) {
  const entries = await readdir(parent, { withFileTypes: true });
  const entry = entries.find(item => item.name.normalize('NFC') === wanted.normalize('NFC'));
  if (!entry) throw new Error(`Kunde inte hitta ${wanted} under ${parent}`);
  return resolve(parent, entry.name);
}

const wikiGroup = await childByNfc(PROJEKT, '2 Wikis & källor');
const wikiRoot = await childByNfc(wikiGroup, 'Wiki Korpholmen & släkten');
const digitalRoot = await childByNfc(wikiRoot, 'Digitalisering 2026');
const documentRoot = await childByNfc(digitalRoot, '01 Digitaliserade dokument');
const appsRoot = REPO;

const peoplePath = resolve(appsRoot, 'apps/matrikel/privat/migrering-2026-08-01/approved-excel-import.json');
const boatsPath = resolve(appsRoot, 'apps/batregister/privat/kallkopior/byggkit/batregister.json');
const peopleData = JSON.parse(await readFile(peoplePath, 'utf8'));
const boatData = JSON.parse(await readFile(boatsPath, 'utf8'));
const people = new Map(peopleData.people.map(person => [person.id, person]));
const boats = new Map(boatData.batar.map(boat => [boat.id, boat]));

const entityRegistry = [
  { id: 'person:nilshenrikhedström', name: 'Nils-Henrik Hedström', type: 'person', aliases: ['Nils-Henrik Hedström'], app: 'Matrikeln', external_id: 'nilshenrikhedström', match: 'kopplad' },
  { id: 'person:ingerbethge', name: 'Inger Bethge', type: 'person', aliases: ['Inger Bethge', 'Inger och Per Olof Bethge'], app: 'Matrikeln', external_id: 'ingerbethge', match: 'kopplad' },
  { id: 'person:perolofbethge', name: 'Per Olof Bethge', type: 'person', aliases: ['Per Olof Bethge', 'Inger och Per Olof Bethge'], app: 'Matrikeln', external_id: 'perolofbethge', match: 'kopplad' },
  { id: 'person:peraxelweslien', name: 'Per-Axel Weslien', type: 'person', aliases: ['Per-Axel Weslien', 'P-A Weslien'], app: 'Matrikeln', external_id: 'peraxelweslien', match: 'kopplad' },
  { id: 'person:carlgunderhedström', name: 'Carl-Gunder Hedström', type: 'person', aliases: ['Carl-Gunder Hedström', 'C-G Hedström', 'C. G. Hedström'], app: 'Matrikeln', external_id: 'carlgunderhedström', match: 'kopplad' },
  { id: 'person:hasseune', name: 'Hans A. Une', type: 'person', aliases: ['Hans A. Une', 'Hasse', 'Hans och Mark Une'], app: 'Matrikeln', external_id: 'hasseune', match: 'kopplad' },
  { id: 'person:markune', name: 'Mark Une', type: 'person', aliases: ['Mark Une', 'Marks och mina', 'Hans och Mark Une'], app: 'Matrikeln', external_id: 'markune', match: 'kopplad' },
  { id: 'person:britaune', name: 'Brita Une', type: 'person', aliases: ['Brita Une'], app: 'Matrikeln', external_id: 'britaune', match: 'kopplad' },
  { id: 'person:petteråkerman', name: 'Petter Åkerman', type: 'person', aliases: ['Petter Åkerman'], app: 'Matrikeln', external_id: 'petteråkerman', match: 'kopplad' },
  { id: 'person:görvelåkerman', name: 'Görvel Åkerman', type: 'person', aliases: ['Görvel Åkerman'], app: 'Matrikeln', external_id: 'görvelåkerman', match: 'kopplad' },
  { id: 'person:rutweslien', name: 'Rut Weslien', type: 'person', aliases: ['Rut Weslien', 'Ruth Weslien', 'fru Ruth'], app: 'Matrikeln', external_id: 'rutweslien', match: 'granska', note: 'Avskriften använder både Rut och Ruth; kontrollera namnformen mot Matrikeln.' },
  { id: 'person:thomashedström', name: 'Tomas Hedström', type: 'person', aliases: ['Tomas Hedström'], app: 'Matrikeln', external_id: 'thomashedström', match: 'granska', note: 'Matrikeln har Thomas Hedström. Identiteten ska bekräftas före skarp koppling.' },
  { id: 'person:carlhenriknordlander', name: 'Henrik Nordlander', type: 'person', aliases: ['Henrik Nordlander', 'Carl-Henrik Nordlander'], app: 'Matrikeln', external_id: 'carlhenriknordlander', match: 'granska', note: 'Dokumentet använder både Henrik och Carl-Henrik; möjlig identitet i Matrikeln.' },
  { id: 'person:rolf-une-olöst', name: 'Rolf Une', type: 'person', aliases: ['Rolf Une'], match: 'saknas' },
  { id: 'person:agneta-ekström-olöst', name: 'Agneta Ekström', type: 'person', aliases: ['Agneta Ekström'], match: 'saknas' },
  { id: 'person:karin-näsmark-olöst', name: 'Karin Näsmark', type: 'person', aliases: ['Karin Näsmark'], match: 'saknas' },
  { id: 'person:margareta-nordlander-olöst', name: 'Margareta Nordlander', type: 'person', aliases: ['Margareta Nordlander'], match: 'saknas' },
  { id: 'person:lena-1955-olöst', name: 'Lena (tävlingslistan 1955)', type: 'person', aliases: ['| Lena |'], match: 'granska', note: 'Endast förnamn i resultatlistan; identiteten är inte fastställd.' },
  { id: 'person:gunnel-1955-olöst', name: 'Gunnel (tävlingslistan 1955)', type: 'person', aliases: ['| Gunnel |'], match: 'granska', note: 'Endast förnamn i resultatlistan; identiteten är inte fastställd.' },
  { id: 'person:joh-1955-olöst', name: 'Joh (tävlingslistan 1955)', type: 'person', aliases: ['| Joh |'], match: 'saknas', note: 'Namnet är återgivet som Joh och saknar säker identifiering.' },
  { id: 'person:kerstin-1955-olöst', name: 'Kerstin (tävlingslistan 1955)', type: 'person', aliases: ['| Kerstin |'], match: 'granska', note: 'Endast förnamn i resultatlistan; identiteten är inte fastställd.' },
  { id: 'person:bibbo-1955-olöst', name: 'Bibbo (tävlingslistan 1955)', type: 'person', aliases: ['| Bibbo |'], match: 'saknas', note: 'Möjligen ett smeknamn; identiteten är inte fastställd.' },
  { id: 'boat:atlanta', name: 'Atlanta', type: 'båt', aliases: ['Atlanta', 'r/s Atlanta', 'r-s Atlanta'], app: 'Båtregistret', external_id: 'atlanta', match: 'kopplad' },
  { id: 'boat:heffan-olöst', name: 'Heffan', type: 'båt', aliases: ['Heffan'], app: 'Båtregistret', match: 'saknas' },
  { id: 'boat:galejan', name: 'Galejan', type: 'båt', aliases: ['Galejan'], app: 'Båtregistret', external_id: 'galejan', match: 'kopplad' },
  { id: 'boat:gungafin', name: 'Gungafin', type: 'båt', aliases: ['Gungafin', 'Gunga Fin'], app: 'Båtregistret', external_id: 'gungafin', match: 'kopplad' },
  { id: 'boat:vift', name: 'Vift', type: 'båt', aliases: ['Vift'], app: 'Båtregistret', external_id: 'vift', match: 'kopplad' },
  { id: 'boat:pumsbullan', name: 'Pumsbullen', type: 'båt', aliases: ['Pumsbullen', 'Pumsan'], app: 'Båtregistret', external_id: 'pumsbullan', match: 'granska', note: 'Båtregistret har Pumsbullan; dokumenten använder Pumsbullen och möjligen Pumsan.' },
  { id: 'boat:job-olöst', name: 'Job', type: 'båt', aliases: ['Job'], app: 'Båtregistret', match: 'saknas' },
  { id: 'boat:dramaten-olöst', name: 'Dramaten', type: 'båt', aliases: ['Dramaten'], app: 'Båtregistret', match: 'saknas' },
  { id: 'place:korpholmen', name: 'Korpholmen', type: 'plats', aliases: ['Korpholmen'], match: 'lokal' },
  { id: 'place:sviholmen', name: 'Sviholmen', type: 'plats', aliases: ['Sviholmen'], match: 'lokal' },
  { id: 'place:stugholmen', name: 'Stugholmen', type: 'plats', aliases: ['Stugholmen'], match: 'lokal' },
  { id: 'organization:kbk', name: 'Korpholmens Båtklubb', type: 'organisation', aliases: ['Korpholmens Båtklubb', 'KBK'], match: 'lokal' },
  { id: 'organization:sagsamfund', name: 'Korpholmens Sågsamfund', type: 'organisation', aliases: ['Korpholmens Sågsamfund', 'Sågsamfund'], match: 'lokal' },
];

for (const entity of entityRegistry.filter(item => item.app === 'Matrikeln')) {
  const target = people.get(entity.external_id);
  if (!target) throw new Error(`Matrikel-ID saknas: ${entity.external_id}`);
}
for (const entity of entityRegistry.filter(item => item.app === 'Båtregistret' && item.external_id)) {
  if (!boats.has(entity.external_id)) throw new Error(`Båtregistrets stabila ID saknas: ${entity.external_id}`);
}

async function findTranscripts(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const fullPath = resolve(folder, entry.name);
    if (entry.isDirectory()) result.push(...await findTranscripts(fullPath));
    else if (entry.isFile() && entry.name.endsWith(' – avskrift.md')) result.push(fullPath);
  }
  return result;
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split('\n').map(line => line.match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map(parts => [parts[1].trim(), parts[2].trim()]));
}

function transcript(text) {
  const start = text.indexOf('\n## Avskrift\n');
  if (start < 0) return '';
  const body = text.slice(start + '\n## Avskrift\n'.length);
  const end = body.search(/\n## (?:Osäkra läsningar|Identifieringar|Anmärkningar)/);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

function category(type) {
  if (type === 'protokoll') return 'Protokoll';
  if (['arbetsanteckning', 'kontrollprotokoll', 'kontrollanteckning', 'resultatlista', 'tidtagningsanteckning', 'väderanteckning och intyg'].includes(type)) return 'Tävlingshandlingar';
  if (['svarsbrev', 'cirkulärbrev', 'följebrev', 'skrivelse', 'kallelse'].includes(type)) return 'Brev & skrivelser';
  if (['stadgeförslag', 'förvaltningsberättelse'].includes(type)) return 'Organisation';
  if (['diagrambilaga', 'humoristisk utredning'].includes(type)) return 'Berättelser & bilagor';
  return 'Arkivöversikt';
}

const normalize = value => String(value || '').normalize('NFC').toLocaleLowerCase('sv');
const slug = value => normalize(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function documentId(sourcePath) {
  const value = slug(sourcePath);
  if (value.length <= 220) return `document:${value}`;
  const suffix = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  return `document:${value.slice(0, 207).replace(/-+$/g, '')}-${suffix}`;
}
const sourceFiles = (await findTranscripts(documentRoot)).sort((a, b) => a.localeCompare(b, 'sv'));
const documents = [];

for (const sourceFile of sourceFiles) {
  const text = await readFile(sourceFile, 'utf8');
  const meta = frontmatter(text);
  const transcription = transcript(text);
  const search = normalize(`${meta.titel || ''}\n${transcription}`);
  const entityIds = entityRegistry.filter(entity => entity.aliases.some(alias => search.includes(normalize(alias)))).map(entity => entity.id);
  const date = meta.dokumentdatum || 'okänt';
  const year = date.match(/\d{4}/)?.[0] || null;
  const imageRows = [...text.matchAll(/^\|\s*(\d{2})\s*\|/gm)].map(match => Number(match[1]));
  const sourcePath = relative(digitalRoot, sourceFile).split(sep).join('/');
  documents.push({
    id: documentId(sourcePath),
    fields: {
      title: meta.titel || basename(sourceFile, ' – avskrift.md'),
      document_date: date,
      year: year ? Number(year) : null,
      dating: meta.datering || 'okänd',
      document_type: meta.dokumenttyp || 'okänd',
      category: category(meta.dokumenttyp || 'okänd'),
      status: meta.avskriftsstatus || 'okänd',
      image_count: imageRows.length ? Math.max(...imageRows) : 0,
      source_path: sourcePath,
      transcript: transcription,
      entity_ids: entityIds,
    },
  });
}

if (!documents.length) throw new Error('Inga avskrifter hittades');
if (new Set(documents.map(document => document.id)).size !== documents.length) throw new Error('Dokument-ID:n är inte unika');

let seq = 0;
const operations = [];
function set(entityType, entityId, field, value) {
  seq += 1;
  operations.push({
    op_id: `${DEVICE}:${seq}`,
    device_id: DEVICE,
    seq,
    entity_type: entityType,
    entity_id: entityId,
    field,
    value,
    hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`,
    schema_version: 1,
  });
}

for (const document of documents) for (const [field, value] of Object.entries(document.fields)) set('document', document.id, field, value);
for (const entity of entityRegistry) {
  const fields = {
    name: entity.name,
    entity_type: entity.type,
    match_status: entity.match,
    app: entity.app || null,
    external_id: entity.external_id || null,
    note: entity.note || null,
    url: entity.app === 'Matrikeln' && entity.external_id
      ? `../matrikel/?person=${encodeURIComponent(entity.external_id)}`
      : entity.app === 'Båtregistret' ? '../batregister/' : null,
  };
  for (const [field, value] of Object.entries(fields)) set('archive-entity', entity.id, field, value);
}

const sourceHash = createHash('sha256');
for (const sourceFile of sourceFiles) sourceHash.update(await readFile(sourceFile));
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'initial-ops.json'), `${JSON.stringify({
  operations_version: 1,
  migration_id: 'dokumentarkiv-2026-08-02',
  device_id: DEVICE,
  source_sha256: sourceHash.digest('hex'),
  counts: { documents: documents.length, entities: entityRegistry.length, operations: operations.length },
  operations,
}, null, 2)}\n`);

console.log(`Dokumentarkivets startmaster byggd: ${documents.length} dokument, ${entityRegistry.length} entiteter, ${operations.length} operationer.`);
