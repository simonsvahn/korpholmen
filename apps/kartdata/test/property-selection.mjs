import assert from 'node:assert/strict';
import { propertySelectionState, validatePropertySelection } from '../src/property-selection.js';

let passed = 0;
async function test(name, action) {
  await action();
  passed += 1;
  console.log(`✓ ${name}`);
}

const references = [
  { external_id: 'Alsvik 3:1', url: '../fastigheter/?property=Alsvik%203%3A1' },
  { external_id: 'Alsvik 3:2', url: '../fastigheter/?property=Alsvik%203%3A2' },
];

await test('en befintlig okänd fastighetslänk behålls synlig i urvalet', () => {
  const state = propertySelectionState(['Alsvik 3:1', 'Äldre fastighets-ID'], references);
  assert.deepEqual(state.selected.map(item => ({ id: item.id, known: item.known })), [
    { id: 'Alsvik 3:1', known: true },
    { id: 'Äldre fastighets-ID', known: false },
  ]);
  assert.deepEqual(state.available.map(item => item.external_id), ['Alsvik 3:2']);
});

await test('en tidigare länk får sparas även när ägarmastern tillfälligt saknar ID:t', () => {
  assert.deepEqual(validatePropertySelection({
    selectedIds: ['Äldre fastighets-ID'],
    propertyReferences: references,
    existingIds: ['Äldre fastighets-ID'],
  }), ['Äldre fastighets-ID']);
});

await test('ett nytt godtyckligt okänt ID kan inte injiceras via formuläret', () => {
  assert.throws(() => validatePropertySelection({
    selectedIds: ['Påhittad 9:9'],
    propertyReferences: references,
    existingIds: ['Äldre fastighets-ID'],
  }), /saknas i Fastighetshistorik/);
});

console.log(`\n${passed} fastighetsurvalskontrakt godkända.`);
