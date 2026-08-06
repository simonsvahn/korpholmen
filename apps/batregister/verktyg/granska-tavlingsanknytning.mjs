import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materialize } from '../../../packages/core/domain/materializer.js';

const root = process.argv[2];
const names = new Set(process.argv.slice(3).map(value => value.toLocaleLowerCase('sv')));
if (!root || !names.size) throw new Error('Användning: node granska-tavlingsanknytning.mjs OPS-ROT NAMN...');

async function jsonFiles(path) {
  const output = [];
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const child = join(parent, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(child);
    }
  }
  await visit(path);
  return output.sort();
}

const batches = await Promise.all((await jsonFiles(root)).map(async path => JSON.parse(await readFile(path, 'utf8'))));
const state = materialize(batches.flatMap(batch => batch.ops || batch.operations || []));
const rows = type => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const boats = rows('boat-ref');
const results = rows('race-result');
const links = rows('race-person-link');
const people = new Map(rows('person-ref').map(person => [person.id, person]));
const selected = boats.filter(boat => names.has(String(boat.name || boat.namn || boat.canonical_name || '').toLocaleLowerCase('sv')));
const output = selected.map(boat => ({
  boat,
  appearances: results.filter(result => result.boat_id === boat.external_id).map(result => ({
    result,
    contestants: links.filter(link => link.result_id === result.id).map(link => ({
      ...link,
      person: people.get(link.person_id) || null,
    })),
  })),
}));
console.log(JSON.stringify(output, null, 2));
