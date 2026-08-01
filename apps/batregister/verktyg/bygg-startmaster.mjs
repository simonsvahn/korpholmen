import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../matrikel/src/domain/materializer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'privat/kallkopior');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-01');
const IMAGE_OUT = resolve(OUT, 'bilder');
const MATRICLE = resolve(ROOT, '../matrikel/privat/migrering-2026-08-01');
const DEVICE = 'migration-batregister-2026-08-01';
const CLOCK_MS = 1785592800000;

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const norm = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const padded = value => ` ${norm(value)} `;
const tokens = value => norm(value).split(/\s+/).filter(Boolean);

await mkdir(IMAGE_OUT, { recursive: true });
const [boatDb, sourceHtml, initial, metadata, approved] = await Promise.all([
  readJson(resolve(SOURCE, 'byggkit/batregister.json')),
  readFile(resolve(SOURCE, 'Båtflottan – bildregistret.html'), 'utf8'),
  readJson(resolve(MATRICLE, 'initial-ops.json')),
  readJson(resolve(MATRICLE, 'ui-metadata-ops.json')),
  readJson(resolve(MATRICLE, 'approved-excel-ops.json')),
]);

const markerStart = sourceHtml.indexOf('const B=');
const markerEnd = sourceHtml.indexOf(';const yta=', markerStart);
if (markerStart < 0 || markerEnd < 0) throw new Error('Kunde inte hitta den inbyggda båtdatan');
const visualBoats = JSON.parse(sourceHtml.slice(markerStart + 'const B='.length, markerEnd));
if (visualBoats.length !== boatDb.batar.length) throw new Error('Båtantalet skiljer sig mellan JSON och HTML');

const personState = materialize([...initial.operations, ...metadata.operations, ...approved.operations]);
const people = personState.listEntities('person').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const personVariants = people.map(person => ({
  person,
  variants: [person.display_name, person.club_name, ...(person.aliases || [])]
    .filter(value => tokens(value).length >= 2),
}));

const uniqueExact = new Map();
for (const entry of personVariants) for (const variant of entry.variants) {
  const key = norm(variant);
  if (!uniqueExact.has(key)) uniqueExact.set(key, []);
  uniqueExact.get(key).push(entry.person);
}
const secureVariants = [...uniqueExact.entries()]
  .filter(([, candidates]) => candidates.length === 1)
  .map(([variant, [person]]) => ({ variant, person }));

function securePeople(boat) {
  const found = new Map();
  const haystack = padded(`${boat.agare || ''} ${(boat.agarkedja || []).map(item => item.vem).join(' ')}`);
  for (const { person, variant } of secureVariants) {
    if (haystack.includes(` ${variant} `)) {
      found.set(person.id, { person, reason: `Entydig exakt namnvariant i ägarfältet: ${variant}` });
    }
  }
  for (const raw of boat.kbk_personer || []) {
    const [clubLabel, oldName] = raw.split('=').map(value => value.trim());
    const byClub = uniqueExact.get(norm(clubLabel)) || [];
    const byName = uniqueExact.get(norm(oldName)) || [];
    const candidates = byClub.length === 1 ? byClub : byName.length === 1 ? byName : [];
    if (candidates.length === 1) {
      found.set(candidates[0].id, {
        person: candidates[0],
        reason: byClub.length === 1 ? `Exakt klubbnamn: ${clubLabel}` : `Exakt namn: ${oldName}`,
      });
    }
  }
  return [...found.values()];
}

const imageFiles = new Map();
const boats = [];
const links = [];
for (let index = 0; index < boatDb.batar.length; index += 1) {
  const sourceBoat = boatDb.batar[index];
  const visualBoat = visualBoats[index];
  if (sourceBoat.namn !== visualBoat.namn) throw new Error(`Båtordningen skiljer sig vid ${sourceBoat.id}`);
  const images = [];
  for (let imageIndex = 0; imageIndex < (visualBoat.img || []).length; imageIndex += 1) {
    const image = visualBoat.img[imageIndex];
    const writeImage = async (base64, role) => {
      if (!base64) return null;
      const buffer = Buffer.from(base64, 'base64');
      const hash = sha256(buffer);
      const filename = `${hash}.jpg`;
      if (!imageFiles.has(hash)) {
        imageFiles.set(hash, { filename, bytes: buffer.length, sha256: hash, dropbox_path: `/batregister/bilder/${filename}` });
        await writeFile(resolve(IMAGE_OUT, filename), buffer);
      }
      return { role, filename, sha256: hash, dropbox_path: `/batregister/bilder/${filename}` };
    };
    const thumb = await writeImage(image.t, 'miniatyr');
    const full = await writeImage(image.s || image.t, 'stor');
    images.push({
      id: `${sourceBoat.id}-${imageIndex + 1}`,
      thumb,
      full,
      focus: image.f || null,
      fit: image.p || null,
      source: sourceBoat.bilder?.[imageIndex] || null,
    });
  }
  const fields = { ...sourceBoat, images };
  delete fields.bilder;
  boats.push({ id: sourceBoat.id, fields });
  for (const match of securePeople(sourceBoat)) {
    links.push({
      id: `${sourceBoat.id}--${match.person.id}`,
      fields: {
        boat_id: sourceBoat.id,
        person_id: match.person.id,
        person_display_name: match.person.display_name,
        role: 'ägare/anknuten',
        confidence: 'säker',
        source: match.reason,
      },
    });
  }
}

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

set('root', 'batregister', 'schema_version', 1);
set('root', 'batregister', 'migration_id', '2026-08-01-batflottan-bildregistret');
set('root', 'batregister', 'source_sha256', sha256(sourceHtml));
for (const boat of boats) for (const [field, value] of Object.entries(boat.fields)) set('boat', boat.id, field, value);
for (const link of links) for (const [field, value] of Object.entries(link.fields)) set('boat-person-link', link.id, field, value);

const document = {
  operations_version: 1,
  dataset: 'batregister',
  device_id: DEVICE,
  migration_id: '2026-08-01-batflottan-bildregistret',
  counts: { boats: boats.length, boat_person_links: links.length, image_records: boats.reduce((sum, boat) => sum + boat.fields.images.length, 0), image_files: imageFiles.size },
  operations,
};
const manifest = {
  migration_id: document.migration_id,
  source: { path: '../kallkopior/Båtflottan – bildregistret.html', sha256: sha256(sourceHtml) },
  generated_from: ['byggkit/batregister.json', 'Båtflottan – bildregistret.html'],
  counts: document.counts,
  image_files: [...imageFiles.values()].sort((a, b) => a.filename.localeCompare(b.filename)),
  principle: 'Båtdata och bildkopior migreras oförändrade. Endast exakta personnamn eller exakta klubbnamn länkas automatiskt.',
};
await writeFile(resolve(OUT, 'initial-ops.json'), JSON.stringify(document, null, 2));
await writeFile(resolve(OUT, 'bildmanifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ operations: operations.length, ...document.counts, image_bytes: [...imageFiles.values()].reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
