import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPersonProfile, buildSearchIndex, searchExplorer } from '../src/projection.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, action) { await action(); passed += 1; console.log(`✓ ${name}`); }

const masters = {
  matrikel: {
    person: [
      { id: 'anna', display_name: 'Anna Holm', birth_year: 1970 },
      { id: 'bjorn', display_name: 'Björn Holm' },
    ],
    relation: [{ id: 'relation:1', kind: 'syskon', from_person_id: 'anna', to_person_id: 'bjorn', user_confirmed: true }],
    'family-unit': [], 'kin-group': [],
    'property-link': [{ id: 'property-link:1', person_id: 'anna', property_id: 'Alsvik 3:1' }],
  },
  batregister: {
    boat: [{ id: 'majsol', namn: 'Majsol', typ: 'Örnjolle' }],
    'boat-ownership-observation': [{ id: 'owner:majsol:anna', boat_id: 'majsol', party_type: 'person', party_id: 'anna', start: '2013' }],
    'boat-person-link': [],
  },
  fastigheter: {
    property: [{ id: 'Alsvik 3:1', display_name: 'Alsvik 3:1' }],
    party: [{ id: 'party:anna', person_id: 'anna', name: 'Anna Holm' }],
    'current-owner-assessment': [{ id: 'current:3:1', property_id: 'Alsvik 3:1', owner_party_ids: ['party:anna'] }],
    'community-link': [],
  },
  dokumentarkiv: {
    'archive-entity': [{ id: 'person:anna', entity_type: 'person', external_id: 'anna', match_status: 'kopplad' }],
    document: [{ id: 'document:1', title: 'Årsmötesprotokoll', document_date: '2001-01-01', transcript: 'Anna Holm valdes.', entity_ids: ['person:anna'] }],
  },
  korpholmenrunt: {
    'race-result': [{ id: 'race-result:1976:1', year: 1976, boat_id: 'majsol', boat_name_raw: 'Sommarsol', class_name: 'Örnjolle', course_code: 'S', time_raw: '65,50', participants_raw: ['Anna'] }],
    'race-person-link': [{ id: 'race-person-link:1', result_id: 'race-result:1976:1', person_id: 'anna', raw_name: 'Anna', match_status: 'manuell', confirmed: true }],
    'race-edition': [],
  },
  klubbhistorik: {
    'matrikel-release': [{ id: 'matrikel-1996', year: 1996 }],
    'person-occurrence': [{ id: 'occurrence:1', release_id: 'matrikel-1996', person_id: 'anna', person_name_raw: 'Anna Holm', confirmed: true, retained: true }],
  },
  kartdata: {},
};

await test('sökningen prioriterar stabila registerträffar framför källtext', () => {
  const index = buildSearchIndex(masters);
  const results = searchExplorer(index, 'Anna');
  assert.equal(results[0].type, 'person');
  assert.equal(results[0].id, 'anna');
  assert.ok(results.some(item => item.type === 'document'));
  assert.ok(results.some(item => item.type === 'source-text'));
  assert.ok(results.indexOf(results.find(item => item.type === 'source-text')) > results.indexOf(results.find(item => item.type === 'person')));
});

await test('personsidan sammanställer bara uttryckliga kopplingar', () => {
  const profile = buildPersonProfile(masters, 'anna');
  assert.equal(profile.name, 'Anna Holm');
  assert.deepEqual(profile.relations.map(item => item.personId), ['bjorn']);
  assert.deepEqual(profile.boats.map(item => item.id), ['majsol']);
  assert.equal(profile.properties[0].currentOwner, true);
  assert.equal(profile.properties[0].associated, true);
  assert.deepEqual(profile.raceResults.map(item => item.id), ['race-result:1976:1']);
  assert.deepEqual(profile.documents.map(item => item.id), ['document:1']);
  assert.deepEqual(profile.clubOccurrences.map(item => item.releaseId), ['matrikel-1996']);
});

await test('förslag utan bekräftad personkoppling blir inte personfakta', () => {
  const changed = structuredClone(masters);
  changed.korpholmenrunt['race-person-link'][0].confirmed = false;
  changed.korpholmenrunt['race-person-link'][0].match_status = 'föreslagen';
  assert.equal(buildPersonProfile(changed, 'anna').raceResults.length, 0);
});

await test('gränssnittet beskriver Explorer som skrivskyddad läsvy', async () => {
  const [html, app, readme] = await Promise.all(['index.html', 'src/app.js', 'README.md'].map(file => readFile(resolve(ROOT, file), 'utf8')));
  assert.match(html, /Explorer visar sammanhang men sparar inga egna fakta/);
  assert.match(app, /explorer-read-/);
  assert.doesNotMatch(app, /setField\(|setFields\(|deleteEntity\(|syncOnce\(/);
  assert.match(readme, /ingen egen master/);
});

console.log(`\n${passed} Explorer-kontrakt godkända.`);
