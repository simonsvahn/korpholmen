import assert from 'node:assert/strict';
import { PeopleV2Runtime, familyUnitView, kinshipView } from '../src/people-v2-runtime.js';

const people = [
  { id: 'anna', display_name: 'Anna' },
  { id: 'peter', display_name: 'Peter' },
  { id: 'elsa', display_name: 'Elsa' },
  { id: 'hugo', display_name: 'Hugo' },
  { id: 'annan', display_name: 'Annan' },
];
const relations = [
  { relation_type: 'partner', from_person_id: 'anna', to_person_id: 'peter' },
  { relation_type: 'foralder-barn', from_person_id: 'anna', to_person_id: 'elsa' },
  { relation_type: 'foralder-barn', from_person_id: 'peter', to_person_id: 'elsa' },
  { relation_type: 'foralder-barn', from_person_id: 'anna', to_person_id: 'hugo' },
  { relation_type: 'foralder-barn', from_person_id: 'annan', to_person_id: 'hugo' },
];

const derived = familyUnitView({
  id: 'familj-1',
  display_name: 'Anna och Peter',
  anchor_person_ids: ['anna', 'peter'],
  membership_rule: 'anchors_and_shared_children',
}, people, relations);

assert.deepEqual(derived.anchors.map(person => person.id), ['anna', 'peter']);
assert.deepEqual(derived.children.map(person => person.id), ['elsa']);
assert.deepEqual(derived.member_ids, ['anna', 'peter', 'elsa']);
assert.deepEqual(derived.party_member_ids, ['anna', 'peter', 'elsa']);
assert.equal(derived.member_count, 3);

const ownerTarget = familyUnitView({
  id: 'familj-2',
  anchor_person_ids: ['anna', 'peter'],
  membership_scope: 'named_family_unit',
}, people, relations);

assert.deepEqual(ownerTarget.children.map(person => person.id), ['elsa']);
assert.deepEqual(ownerTarget.member_ids, ['anna', 'peter', 'elsa']);
assert.deepEqual(ownerTarget.party_member_ids, ['anna', 'peter']);

const kinship = kinshipView(people, relations);
assert.equal(kinship.connected.length, 1);
assert.equal(kinship.connected[0].size, 5);
assert.equal(kinship.isolated.length, 0);
assert.deepEqual((kinship.graph.children.get('anna') || []).map(row => row.id), ['elsa', 'hugo']);
assert.deepEqual((kinship.graph.partners.get('anna') || []).map(row => row.id).sort(), ['annan', 'peter']);

const runtime = Object.create(PeopleV2Runtime.prototype);
runtime.listFamilies = () => [{ id: 'familj-1', party_member_ids: ['anna', 'peter'] }];
runtime.context = {
  list(source, collection) {
    return {
      'boats:boats': [{ id: 'båt-1', events: [{ participants: [{ party_ref: { master: 'people', entity_type: 'family_unit', entity_id: 'familj-1' } }] }] }],
      'properties:affiliations': [{ person_ref: { master: 'people', entity_id: 'anna' }, property_ref: { entity_id: 'Alsvik 3:1' } }],
      'properties:timeline_entries': [],
      'properties:properties': [{ id: 'Alsvik 3:1', designation: 'Alsvik 3:1' }],
      'documents:document_links': [{ document_ref: { entity_id: 'doc-1' }, target_ref: { master: 'people', entity_type: 'person', entity_id: 'anna' } }],
      'documents:documents': [{ id: 'doc-1', title: 'Protokoll' }],
      'race:participants': [{ result_id: 'resultat-1', person_ref: { master: 'people', entity_type: 'person', entity_id: 'anna' } }],
      'race:results': [{ id: 'resultat-1', year: 2020 }],
    }[`${source}:${collection}`] || [];
  },
};
assert.deepEqual(runtime.boatsFor('anna').map(row => row.id), ['båt-1']);
assert.deepEqual(runtime.boatsFor('elsa'), []);
assert.deepEqual(runtime.propertiesFor('anna').map(row => row.id), ['Alsvik 3:1']);
assert.deepEqual(runtime.documentsFor('anna').map(row => row.id), ['doc-1']);
assert.deepEqual(runtime.raceYearsFor('anna'), [{ year: '2020', count: 1 }]);

console.log('✓ V2-familjer och tvärlänkar byggs från stabila master-ID:n');
