import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PROJEKT = process.env.KORPHOLMEN_PROJEKT_ROOT ? resolve(process.env.KORPHOLMEN_PROJEKT_ROOT) : resolve(REPO, '../../..');
const PRIVATE_DATA_REPO = process.env.KORPHOLMEN_PRIVAT_DATA_REPO ? resolve(process.env.KORPHOLMEN_PRIVAT_DATA_REPO) : REPO;
const MIGRATION_TAG = process.env.KORPHOLMEN_MIGRATION_TAG || '2026-08-03-arkivatlas';
const OUT = resolve(ROOT, 'privat/aktuell-startmaster');
const DEVICE = `migration-dokumentarkiv-${MIGRATION_TAG}`;
const CLOCK_MS = Date.parse(process.env.KORPHOLMEN_MIGRATION_CLOCK || '2026-08-03T12:00:00Z');
const PUBLISHABLE_STATUSES = new Set(['färdig', 'kontroll behövs']);
const normalize = value => String(value || '').normalize('NFC').toLocaleLowerCase('sv');
const isPublishableStatus = value => PUBLISHABLE_STATUSES.has(value) || /^granskad(?:\s|\(|$)/iu.test(String(value || '').trim());
const slug = value => normalize(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasPattern(alias) {
  const normalized = String(alias || '').normalize('NFC').trim();
  if (!normalized) return null;
  const source = normalized.split(/\s+/).map(escapeRegex).join('[\\p{Zs}\\t]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, 'iu');
}

function entityMention(searchText, entity) {
  if (entity.auto_match === false) return null;
  for (const alias of entity.aliases) {
    const pattern = aliasPattern(alias);
    const match = pattern?.exec(searchText);
    if (!match) continue;
    const lineStart = searchText.lastIndexOf('\n', match.index) + 1;
    const lineEndCandidate = searchText.indexOf('\n', match.index);
    const lineEnd = lineEndCandidate < 0 ? searchText.length : lineEndCandidate;
    return {
      entity_id: entity.id,
      entity_type: entity.type,
      external_id: entity.external_id || null,
      source_label: match[0],
      relation: 'nämns',
      link_status: entity.match,
      evidence_quote: searchText.slice(lineStart, lineEnd).trim(),
    };
  }
  return null;
}

async function childByNfc(parent, wanted) {
  const entries = await readdir(parent, { withFileTypes: true });
  const entry = entries.find(item => item.name.normalize('NFC') === wanted.normalize('NFC'));
  if (!entry) throw new Error(`Kunde inte hitta ${wanted} under ${parent}`);
  return resolve(parent, entry.name);
}

const wikiGroup = await childByNfc(PROJEKT, '2 Wikis & källor');
const wikiRoot = await childByNfc(wikiGroup, 'Wiki Korpholmen & släkten');
const digitalRoot = await childByNfc(wikiRoot, 'Digitalisering 2026');
const inboxRoot = await childByNfc(digitalRoot, '00 Inkorg');
const documentRoot = await childByNfc(digitalRoot, '01 Digitaliserade dokument');
const appsRoot = PRIVATE_DATA_REPO;

const peoplePath = resolve(appsRoot, 'apps/matrikel/privat/migrering-2026-08-01/approved-excel-import.json');
const boatsPath = resolve(appsRoot, 'apps/batregister/privat/kallkopior/byggkit/batregister.json');
const propertiesPath = resolve(appsRoot, 'apps/fastigheter/privat/migrering-2026-08-02/research-export.json');
const peopleData = JSON.parse(await readFile(peoplePath, 'utf8'));
const boatData = JSON.parse(await readFile(boatsPath, 'utf8'));
const propertyData = JSON.parse(await readFile(propertiesPath, 'utf8'));
const people = new Map(peopleData.people.map(person => [person.id, person]));
const boats = new Map(boatData.batar.map(boat => [boat.id, boat]));
const properties = new Map(propertyData.tables.property.map(property => [property.id, property]));

const entityRegistry = [
  { id: 'person:nilshenrikhedström', name: 'Nils-Henrik Hedström', type: 'person', aliases: ['Nils-Henrik Hedström', 'Nils Henrik Hedström', 'Nils-Henrik'], app: 'Matrikeln', external_id: 'nilshenrikhedström', match: 'kopplad' },
  { id: 'person:ingerbethge', name: 'Inger Bethge', type: 'person', aliases: ['Inger Bethge', 'Inger och Per Olof Bethge'], app: 'Matrikeln', external_id: 'ingerbethge', match: 'kopplad' },
  { id: 'person:perolofbethge', name: 'Per Olof Bethge', type: 'person', aliases: ['Per Olof Bethge', 'Per-Olof', 'Inger och Per Olof Bethge'], app: 'Matrikeln', external_id: 'perolofbethge', match: 'kopplad' },
  { id: 'person:peraxelweslien', name: 'Per-Axel Weslien', type: 'person', aliases: ['Per-Axel Weslien', 'P-A Weslien'], app: 'Matrikeln', external_id: 'peraxelweslien', match: 'kopplad' },
  { id: 'person:carlgunderhedström', name: 'Carl-Gunder Hedström', type: 'person', aliases: ['Carl-Gunder Hedström', 'C-G Hedström', 'C. G. Hedström'], app: 'Matrikeln', external_id: 'carlgunderhedström', match: 'kopplad' },
  { id: 'person:hasseune', name: 'Hans A. Une', type: 'person', aliases: ['Hans A. Une', 'Hasse', 'Hans och Mark Une'], app: 'Matrikeln', external_id: 'hasseune', match: 'kopplad' },
  { id: 'person:markune', name: 'Mark Une', type: 'person', aliases: ['Mark Une', 'Marks och mina', 'Hans och Mark Une'], app: 'Matrikeln', external_id: 'markune', match: 'kopplad' },
  { id: 'person:britaune', name: 'Brita Une', type: 'person', aliases: ['Brita Une'], app: 'Matrikeln', external_id: 'britaune', match: 'kopplad' },
  { id: 'person:petteråkerman', name: 'Petter Åkerman', type: 'person', aliases: ['Petter Åkerman', 'Petter och Görvel Åkerman'], app: 'Matrikeln', external_id: 'petteråkerman', match: 'kopplad' },
  { id: 'person:görvelåkerman', name: 'Görvel Åkerman', type: 'person', aliases: ['Görvel Åkerman', 'Petter och Görvel Åkerman'], app: 'Matrikeln', external_id: 'görvelåkerman', match: 'kopplad' },
  { id: 'person:rutweslien', name: 'Rut Weslien', type: 'person', aliases: ['Rut Weslien', 'Ruth Weslien', 'fru Ruth'], app: 'Matrikeln', external_id: 'rutweslien', match: 'granska', note: 'Avskriften använder både Rut och Ruth; kontrollera namnformen mot Matrikeln.' },
  { id: 'person:thomashedström', name: 'Thomas Hedström', type: 'person', aliases: ['Thomas Hedström', 'Tomas Hedström'], app: 'Matrikeln', external_id: 'thomashedström', match: 'kopplad' },
  { id: 'person:carlhenriknordlander', name: 'Henrik Nordlander', type: 'person', aliases: ['Henrik Nordlander', 'Carl-Henrik Nordlander'], app: 'Matrikeln', external_id: 'carlhenriknordlander', match: 'granska', note: 'Dokumentet använder både Henrik och Carl-Henrik; möjlig identitet i Matrikeln.' },
  { id: 'person:bobethge', name: 'Bo Bethge', type: 'person', aliases: ['Bo Bethge'], app: 'Matrikeln', external_id: 'bobethge', match: 'kopplad' },
  { id: 'person:lenaböving', name: 'Lena Böving', type: 'person', aliases: ['Lena Böving'], app: 'Matrikeln', external_id: 'lenaböving', match: 'kopplad' },
  { id: 'person:bibbihedström', name: 'Bibbi Hedström', type: 'person', aliases: ['Bibbi Hedström'], app: 'Matrikeln', external_id: 'bibbihedström', match: 'kopplad' },
  { id: 'person:johanhedström', name: 'Johan Hedström', type: 'person', aliases: ['Johan Hedström'], app: 'Matrikeln', external_id: 'johanhedström', match: 'kopplad' },
  { id: 'person:annagretanordlander', name: 'Anna-Greta Nordlander', type: 'person', aliases: ['Anna-Greta Nordlander', 'syster Anna-Greta'], app: 'Matrikeln', external_id: 'annagretanordlander', match: 'kopplad' },
  { id: 'person:svantenäsmark', name: 'Svante Näsmark', type: 'person', aliases: ['Svante Näsmark'], app: 'Matrikeln', external_id: 'svantenäsmark', match: 'kopplad' },
  { id: 'person:mats-sam-une-olöst', name: 'Mats-Sam Une', type: 'person', aliases: ['Mats-Sam Une'], match: 'granska', note: 'Namnet är osäkert läst i årsmötesprotokollet och saknar säker koppling i Matrikeln.' },
  { id: 'person:max-allan-1955-olöst', name: 'Max-Allan', type: 'person', aliases: ['Max-Allan'], match: 'granska', note: 'Endast förnamn finns i avskriften; identiteten är inte fastställd.' },
  { id: 'person:rolf-jörgensen-olöst', name: 'Rolf Jörgensen', type: 'person', aliases: ['Rolf Jörgensen'], match: 'saknas', note: 'Namnet finns på ett kuvert men saknar säker koppling i Matrikeln.' },
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
  { id: 'boat:pumsbullan', name: 'Pumsbullan', type: 'båt', aliases: ['Pumsbullan', 'Pumsbullen', 'Pumsan', 'Pumsbollen', 'Pumsbulan', 'Pumpsbullans', 'Pumsbulla', 'Pumsbulans', 'Pumsbullarnas'], app: 'Båtregistret', external_id: 'pumsbullan', match: 'kopplad' },
  { id: 'boat:job-olöst', name: 'Job', type: 'båt', aliases: ['Job'], app: 'Båtregistret', match: 'saknas' },
  { id: 'boat:dramaten-olöst', name: 'Dramaten', type: 'båt', aliases: ['Dramaten'], app: 'Båtregistret', match: 'saknas' },
  { id: 'place:korpholmen', name: 'Korpholmen', type: 'plats', aliases: ['Korpholmen', 'Stora Korpholmen'], match: 'lokal', map_x: 50, map_y: 54 },
  { id: 'place:sviholmen', name: 'Sviholmen', type: 'plats', aliases: ['Sviholmen', 'Stora Sviholmen'], match: 'lokal', map_x: 59, map_y: 65 },
  { id: 'place:stugholmen', name: 'Stugholmen', type: 'plats', aliases: ['Stugholmen'], match: 'lokal', map_x: 36, map_y: 78 },
  { id: 'place:angsholmen', name: 'Ängsholmen', type: 'plats', aliases: ['Ängsholmen'], match: 'lokal', map_x: 24, map_y: 35 },
  { id: 'place:yxlan', name: 'Yxlan', type: 'plats', aliases: ['Yxlan'], match: 'lokal', map_x: 82, map_y: 45 },
  { id: 'place:brockholmen', name: 'Brokholmen', type: 'plats', aliases: ['Brokholmen', 'Brokholmens', 'Brockholmen', 'Brockholmens'], match: 'lokal', map_x: 68, map_y: 24 },
  { id: 'place:midsommarangen', name: 'Midsommarängen', type: 'plats', aliases: ['Midsommarängen'], match: 'lokal', map_x: 46, map_y: 51 },
  { id: 'house:oroligheten', name: 'Oroligheten', type: 'hus', aliases: ['Oroligheten'], match: 'lokal', map_x: 39, map_y: 62 },
  { id: 'house:korpholmsmuseet', name: 'Korpholmsmuseet', type: 'hus', aliases: ['Korpholmsmuseet', 'telefonkiosken'], match: 'lokal', map_x: 51, map_y: 48 },
  { id: 'organization:kbk', name: 'Korpholmens Båtklubb', type: 'organisation', aliases: ['Korpholmens Båtklubb', 'KBK'], match: 'lokal' },
  { id: 'organization:sagsamfund', name: 'Korpholmens Sågsamfund', type: 'organisation', aliases: ['Korpholmens Sågsamfund', 'Sågsamfund'], match: 'lokal' },
];

const occupiedIds = new Set(entityRegistry.map(entity => entity.id));
const occupiedExternalIds = new Set(entityRegistry.map(entity => entity.external_id).filter(Boolean));
function addRegistryEntity(entity) {
  if (occupiedIds.has(entity.id) || occupiedExternalIds.has(entity.external_id)) return;
  entityRegistry.push(entity);
  occupiedIds.add(entity.id);
  if (entity.external_id) occupiedExternalIds.add(entity.external_id);
}

for (const person of people.values()) {
  const name = String(person.display_name || '').trim();
  if (name.split(/\s+/).length < 2) continue;
  addRegistryEntity({
    id: `person:${person.id}`,
    name,
    type: 'person',
    aliases: [name],
    app: 'Matrikeln',
    external_id: person.id,
    match: 'granska',
    note: 'Fullständigt namn förekommer i avskriften; identiteten är föreslagen från Matrikeln och behöver källkontroll.',
  });
}

for (const boat of boats.values()) {
  const names = [boat.namn, ...(boat.smeknamn || []), ...(boat.tidigare_namn || []), ...(boat.senare_namn || [])].filter(Boolean);
  const canonical = String(boat.namn || '').trim();
  if (!canonical || (canonical.length < 5 && !/[\s\d]/.test(canonical))) continue;
  addRegistryEntity({
    id: `boat:${boat.id}`,
    name: canonical,
    type: 'båt',
    aliases: [...new Set(names)],
    app: 'Båtregistret',
    external_id: boat.id,
    match: 'granska',
    auto_match: false,
    note: 'Båtnamn från Båtregistret auto-matchas inte; kopplingen skapas först efter dokumentbunden källkontroll.',
  });
}

for (const property of properties.values()) {
  addRegistryEntity({
    id: `property:${slug(property.id)}`,
    name: property.display_name || property.id,
    type: 'fastighet',
    aliases: [property.id],
    app: 'Fastigheter',
    external_id: property.id,
    match: 'kopplad',
    note: 'Fastighetsbeteckningen är en exakt träff i Fastighetsmastern.',
  });
}

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

async function findFiles(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const fullPath = resolve(folder, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(fullPath));
    else if (entry.isFile() && !['.gitkeep', '.DS_Store'].includes(entry.name)) result.push(fullPath);
  }
  return result;
}

function parseFrontmatterValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1]
    .split('\n')
    .map(line => line.match(/^([^:]+):\s*(.*)$/))
    .filter(Boolean)
    .map(parts => [parts[1].trim(), parseFrontmatterValue(parts[2].trim())]));
}

function transcript(text) {
  const start = text.indexOf('\n## Avskrift\n');
  if (start < 0) return '';
  const body = text.slice(start + '\n## Avskrift\n'.length);
  const end = body.search(/\n## (?:Osäkra läsningar|Identifieringar|Anmärkningar)/);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

const sourceMimeType = extension => ({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
})[extension.toLocaleLowerCase('sv')] || null;

const unavailableProvenanceFile = value => !String(value || '').trim() || /^[-—](?:\s|$)/.test(String(value).trim());
const unwrapCodeCell = value => String(value || '').trim().replace(/^`([\s\S]*)`$/, '$1');

function provenanceRows(text) {
  const start = text.indexOf('\n## Ursprungliga filer\n');
  if (start < 0) return [];
  const section = text.slice(start + '\n## Ursprungliga filer\n'.length)
    .split(/\n## /)[0]
    .split(/\n### Härledda innehållsbilder/)[0];
  return section.split('\n')
    .filter(line => /^\|\s*`/.test(line))
    .map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(unwrapCodeCell))
    .map(cells => cells.length === 3
      ? { original_filename: cells[0], canonical_original: cells[1], reading_copy: null, original_sha256: cells[2] }
      : { original_filename: cells[0], canonical_original: cells[1], reading_copy: cells[2], original_sha256: cells[3] });
}

const imageMimeType = extension => ({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})[extension.toLocaleLowerCase('sv')] || null;

async function contentImages(transcription, sourceFile) {
  const result = [];
  const pattern = /!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)/g;
  for (const match of transcription.matchAll(pattern)) {
    const alt = match[1].trim();
    const filename = String(match[2] || match[3] || '').trim();
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new Error(`Ogiltig innehållsbild i ${sourceFile}: ${filename}`);
    }
    if (!/ – innehållsbild \d{2}\.(?:jpe?g|png|webp)$/iu.test(filename.normalize('NFD'))) {
      throw new Error(`Innehållsbilden följer inte namnregeln i ${sourceFile}: ${filename}`);
    }
    const sourcePath = resolve(dirname(sourceFile), filename);
    const bytes = await readFile(sourcePath);
    const extension = extname(filename).toLocaleLowerCase('sv');
    const mimeType = imageMimeType(extension);
    if (!mimeType) throw new Error(`Bildformatet stöds inte: ${filename}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    result.push({
      order: result.length + 1,
      alt,
      filename,
      sha256,
      mime_type: mimeType,
      blob_path: `/dokumentarkiv/bilder/${sha256}${extension === '.jpeg' ? '.jpg' : extension}`,
      source_file: sourcePath,
    });
  }
  return result;
}

function category(type) {
  if (['protokoll', 'styrelseprotokoll', 'årsmötesprotokoll', 'sammanträdesprotokoll'].includes(type)) return 'Protokoll';
  if (['arbetsanteckning', 'beräkningsblad', 'fartlista', 'kontrollprotokoll', 'kontrollanteckning', 'målprotokoll', 'passageprotokoll', 'prisanteckning', 'prislista', 'resultatberäkning', 'resultatlista', 'startprotokoll', 'tidtagningsanteckning', 'tidslista', 'väderanteckning och intyg'].includes(type)) return 'Tävlingshandlingar';
  if (['besked', 'kuvert', 'svarsbrev', 'cirkulärbrev', 'följebrev', 'skrivelse', 'kallelse'].includes(type)) return 'Brev & skrivelser';
  if (['föredragningslista', 'medlemsansökan', 'stadgeförslag', 'förvaltningsberättelse'].includes(type)) return 'Organisation';
  if (['diagrambilaga', 'humoristisk utredning'].includes(type)) return 'Berättelser & bilagor';
  return 'Arkivöversikt';
}

const STORY_TRACKS = [
  { id: 'arsmoten', label: 'Årsmöten genom tiderna', description: 'Årsmötesprotokoll, föredragningslistor och närliggande handlingar.', pattern: /årsmöte|förvaltningsberättelse|föredragningslista/i },
  { id: 'tavlingar', label: 'Tävlingar och Korpholmen runt', description: 'Tävlingsprotokoll, loggböcker, tider, resultat och inbjudningar.', pattern: /tävling|korpholmen\s*runt|startprotokoll|målprotokoll|resultat|loggbok|fartlista|tidslista/i },
  { id: 'atlanta', label: 'Atlantaärendet', description: 'Utredningen, bilagorna och senare hänvisningar till r/s Atlanta.', pattern: /atlanta/i },
  { id: 'sagsamfundet', label: 'Korpholmens Sågsamfund', description: 'Cirkulärbrev, stadgeförslag och svar kring Sågsamfundet.', pattern: /sågsamfund/i },
  { id: 'medlemskap', label: 'Medlemskap och inval', description: 'Ansökningar, inval, utträden och korresponderande medlemskap.', pattern: /medlemskap|medlemsansökan|inträde|inval|utträde|korresponderande/i },
  { id: 'hederstecken', label: 'Priser och hederstecken', description: 'Kommittéer, förslag, medaljer och prisutdelningar.', pattern: /hederstecken|hederspris|prislista|prisutdelning|medalj/i },
  { id: 'korrespondens', label: 'Brevväxling', description: 'Brev, skrivelser, besked och kuvert ordnade över tid.', pattern: /brev|skrivelse|besked|kuvert|kallelse/i },
];

function storyTracks(title, transcription, type) {
  const searchable = `${title}\n${type}\n${transcription}`;
  return STORY_TRACKS.filter(track => track.pattern.test(searchable)).map(track => track.id);
}

function collectionLabel(sourcePath, fallback) {
  const parts = sourcePath.split('/');
  const firstFolder = parts[1] || '';
  if (/styrelse- och årsmöteshandlingar/i.test(firstFolder)) return 'Styrelse- och årsmöteshandlingar 1955';
  if (/sågsamfund/i.test(firstFolder)) return 'Korpholmens Sågsamfund 1967';
  if (/båtklubbs handlingar/i.test(firstFolder)) return 'Korpholmens Båtklubbs handlingar 1956';
  if (/tävling/i.test(sourcePath)) return `${sourcePath.match(/\b\d{4}(?:-\d{2}-\d{2})?/)?.[0] || 'Odaterad'} – tävlingshandlingar`;
  return fallback;
}

const LEGACY_DOCUMENT_IDS = new Map([
  [normalize('Korpholmens Båtklubbs förvaltningsberättelse för 1954'), 'document:01-digitaliserade-dokument-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-avskrift-md'],
]);
function documentId(sourcePath, title) {
  const legacyId = LEGACY_DOCUMENT_IDS.get(normalize(title));
  if (legacyId) return legacyId;
  const value = slug(sourcePath);
  if (value.length <= 220) return `document:${value}`;
  const suffix = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  return `document:${value.slice(0, 207).replace(/-+$/g, '')}-${suffix}`;
}
const sourceFiles = (await findTranscripts(documentRoot)).sort((a, b) => a.localeCompare(b, 'sv'));
const packageFilesByName = new Map();
for (const path of await findFiles(documentRoot)) {
  const key = normalize(basename(path));
  if (!packageFilesByName.has(key)) packageFilesByName.set(key, []);
  packageFilesByName.get(key).push(path);
}
const documents = [];
const includedSourceFiles = [];
const includedContentImages = [];
const includedArchiveFiles = [];
const excludedDocuments = [];
const usedEntityIds = new Set();

async function archiveAsset(sourceFile, filename, expectedSha256) {
  if (unavailableProvenanceFile(filename)) return null;
  const extension = extname(filename).toLocaleLowerCase('sv');
  const mimeType = sourceMimeType(extension);
  if (!mimeType) throw new Error(`Källfilen har ett format som Dokumentarkivet inte stöder: ${filename}`);
  const direct = resolve(dirname(sourceFile), filename);
  const candidates = [...new Set([direct, ...(packageFilesByName.get(normalize(filename)) || [])])];
  for (const candidate of candidates) {
    let bytes;
    try { bytes = await readFile(candidate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256.toLocaleLowerCase('sv')) continue;
    const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
    const blobPath = `/dokumentarkiv/kallor/laskopior/${sha256}${normalizedExtension}`;
    const asset = { filename, sha256, mime_type: mimeType, blob_path: blobPath, source_file: candidate, role: 'visningskopia' };
    includedArchiveFiles.push(asset);
    return asset;
  }
  const hashNote = expectedSha256 ? ` med SHA-256 ${expectedSha256}` : '';
  throw new Error(`Kunde inte hitta ${filename}${hashNote} för ${sourceFile}`);
}

async function sourceFileRecords(text, sourceFile) {
  const records = [];
  const rows = provenanceRows(text);
  for (const [index, row] of rows.entries()) {
    if (unavailableProvenanceFile(row.canonical_original)) continue;
    if (!/^[a-f0-9]{64}$/i.test(row.original_sha256 || '')) throw new Error(`Ogiltig originalhash i ${sourceFile}: ${row.original_filename}`);
    const hasReadingCopy = !unavailableProvenanceFile(row.reading_copy);
    const displayCopy = await archiveAsset(
      sourceFile,
      hasReadingCopy ? row.reading_copy : row.canonical_original,
      hasReadingCopy ? null : row.original_sha256,
    );
    if (!hasReadingCopy && displayCopy.mime_type !== 'application/pdf') throw new Error(`Bildoriginalet saknar beskuren JPG-läskopia i ${sourceFile}: ${row.original_filename}`);
    const publicAsset = ({ source_file, role, ...asset }) => asset;
    records.push({
      order: index + 1,
      original_filename: row.original_filename,
      display_copy: publicAsset(displayCopy),
    });
  }
  return { records, originalNames: rows.map(row => row.original_filename) };
}

for (const sourceFile of sourceFiles) {
  const text = await readFile(sourceFile, 'utf8');
  const meta = frontmatter(text);
  const sourcePath = relative(digitalRoot, sourceFile).split(sep).join('/');
  if (!isPublishableStatus(meta.avskriftsstatus)) {
    excludedDocuments.push({ title: meta.titel || basename(sourceFile, ' – avskrift.md'), status: meta.avskriftsstatus || 'okänd', source_path: sourcePath });
    continue;
  }
  includedSourceFiles.push(sourceFile);
  const transcription = transcript(text);
  const documentContentImages = await contentImages(transcription, sourceFile);
  includedContentImages.push(...documentContentImages);
  const searchText = `${meta.titel || ''}\n${transcription}`.normalize('NFC');
  const entityLinks = entityRegistry.map(entity => entityMention(searchText, entity)).filter(Boolean);
  const entityIds = entityLinks.map(link => link.entity_id);
  entityIds.forEach(id => usedEntityIds.add(id));
  const date = meta.dokumentdatum || 'okänt';
  const year = date.match(/\d{4}/)?.[0] || null;
  const { records: archiveFiles, originalNames } = await sourceFileRecords(text, sourceFile);
  const documentType = meta.dokumenttyp || 'okänd';
  const documentCategory = category(documentType);
  documents.push({
    id: documentId(sourcePath, meta.titel),
    fields: {
      title: meta.titel || basename(sourceFile, ' – avskrift.md'),
      document_date: date,
      year: year ? Number(year) : null,
      dating: meta.datering || 'okänd',
      document_type: documentType,
      category: documentCategory,
      status: meta.avskriftsstatus || 'okänd',
      image_count: originalNames.length,
      source_path: sourcePath,
      transcript: transcription,
      entity_ids: entityIds,
      entity_links: entityLinks,
      decade: year ? Math.floor(Number(year) / 10) * 10 : null,
      month: date.match(/^\d{4}-(\d{2})/)?.[1] || null,
      collection: collectionLabel(sourcePath, documentCategory),
      story_track_ids: storyTracks(meta.titel || '', transcription, documentType),
      transcript_sha256: createHash('sha256').update(transcription).digest('hex'),
      word_count: transcription.split(/\s+/).filter(Boolean).length,
      has_uncertainty: /\[(?:osäker|osäkert|oläsligt)/i.test(transcription),
      original_filenames: originalNames,
      source_files: archiveFiles,
      content_images: documentContentImages.map(({ source_file, ...image }) => image),
    },
  });
}

if (!documents.length) throw new Error('Inga publicerbara avskrifter hittades');
if (new Set(documents.map(document => document.id)).size !== documents.length) throw new Error('Dokument-ID:n är inte unika');

const inboxFiles = (await findFiles(inboxRoot)).sort((a, b) => a.localeCompare(b, 'sv'));
// Efter enstegsflödets hashverifierade arkivering ska endast verkligt
// obehandlade eller avvikande filer ligga kvar i inkorgen. Ett omnämnt filnamn
// räcker inte för att dölja filen ur arbetskön.
const pendingInboxFiles = inboxFiles.map(path => relative(inboxRoot, path).split(sep).join('/'));
const statusCounts = Object.fromEntries([...new Set(documents.map(document => document.fields.status))]
  .sort((a, b) => a.localeCompare(b, 'sv'))
  .map(status => [status, documents.filter(document => document.fields.status === status).length]));
const decadeCounts = Object.fromEntries([...new Set(documents.map(document => document.fields.decade).filter(Number.isFinite))]
  .sort((a, b) => a - b)
  .map(decade => [String(decade), documents.filter(document => document.fields.decade === decade).length]));
const archiveSummary = {
  total_documents: documents.length,
  status_counts: statusCounts,
  decade_counts: decadeCounts,
  inbox_total_files: inboxFiles.length,
  inbox_referenced_files: 0,
  inbox_pending_files: pendingInboxFiles,
  excluded_documents: excludedDocuments,
  story_tracks: STORY_TRACKS.map(({ pattern, ...track }) => ({ ...track, count: documents.filter(document => document.fields.story_track_ids.includes(track.id)).length })),
  migration_tag: MIGRATION_TAG,
  generated_at: new Date(CLOCK_MS).toISOString(),
};

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
for (const entity of entityRegistry.filter(item => usedEntityIds.has(item.id))) {
  const fields = {
    name: entity.name,
    entity_type: entity.type,
    match_status: entity.match,
    app: entity.app || null,
    external_id: entity.external_id || null,
    note: entity.note || null,
    map_x: Number.isFinite(entity.map_x) ? entity.map_x : null,
    map_y: Number.isFinite(entity.map_y) ? entity.map_y : null,
    url: entity.app === 'Matrikeln' && entity.external_id
      ? `../matrikel/?person=${encodeURIComponent(entity.external_id)}`
      : entity.app === 'Båtregistret' && entity.external_id ? `../batregister/?boat=${encodeURIComponent(entity.external_id)}`
        : entity.app === 'Fastigheter' && entity.external_id ? `../fastigheter/?property=${encodeURIComponent(entity.external_id)}` : null,
  };
  for (const [field, value] of Object.entries(fields)) set('archive-entity', entity.id, field, value);
}
for (const [field, value] of Object.entries(archiveSummary)) set('archive-summary', 'archive-summary:current', field, value);

const sourceHash = createHash('sha256');
for (const sourceFile of includedSourceFiles) sourceHash.update(await readFile(sourceFile));
for (const image of [...new Map(includedContentImages.map(item => [item.sha256, item])).values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
  sourceHash.update(await readFile(image.source_file));
}
for (const file of [...new Map(includedArchiveFiles.map(item => [item.blob_path, item])).values()].sort((a, b) => a.blob_path.localeCompare(b.blob_path, 'sv'))) {
  sourceHash.update(`${file.role}:${file.sha256}:${file.filename}\n`);
}
for (const inboxFile of inboxFiles.map(path => relative(inboxRoot, path).split(sep).join('/')).sort((a, b) => a.localeCompare(b, 'sv'))) sourceHash.update(inboxFile);
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'initial-ops.json'), `${JSON.stringify({
  operations_version: 1,
  migration_id: `dokumentarkiv-${MIGRATION_TAG}`,
  device_id: DEVICE,
  source_sha256: sourceHash.digest('hex'),
  counts: { documents: documents.length, entities: usedEntityIds.size, operations: operations.length, excluded_documents: excludedDocuments.length, pending_inbox_files: pendingInboxFiles.length },
  excluded_documents: excludedDocuments,
  operations,
}, null, 2)}\n`);
await writeFile(resolve(OUT, 'innehållsbilder.json'), `${JSON.stringify({
  version: 1,
  images: [...new Map(includedContentImages.map(image => [image.sha256, image])).values()]
    .sort((a, b) => a.blob_path.localeCompare(b.blob_path, 'sv')),
}, null, 2)}\n`);
await writeFile(resolve(OUT, 'källfiler.json'), `${JSON.stringify({
  version: 1,
  files: [...new Map(includedArchiveFiles.map(file => [file.blob_path, file])).values()]
    .sort((a, b) => a.blob_path.localeCompare(b.blob_path, 'sv')),
}, null, 2)}\n`);

console.log(`Dokumentarkivets startmaster byggd: ${documents.length} dokument, ${usedEntityIds.size} entiteter, ${includedContentImages.length} innehållsbilder, ${includedArchiveFiles.length} visningskopiereferenser, ${pendingInboxFiles.length} väntande inkorgsfiler, ${operations.length} operationer.`);
