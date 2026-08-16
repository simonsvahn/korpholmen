import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
let passed = 0;
async function test(name, action) { await action(); passed += 1; console.log(`✓ ${name}`); }

await test('Explorer-koden har giltig syntax', () => { const result = spawnSync(process.execPath, ['--check', 'src/app.js'], { cwd: ROOT, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); });
await test('Explorer läser samtliga sju aktiva V2-mastrar', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  for (const path of ['/personer-familjer/active.json', '/matrikel-generation2/active.json', '/batregister-generation2/active.json', '/fastigheter-generation2/active.json', '/dokumentarkiv-generation2/active.json', '/korpholmenrunt-generation2/active.json', '/kartdata-generation2/active.json']) assert.ok(app.includes(path), path);
  assert.doesNotMatch(app, /Repository|syncAppFamily|listEntities/);
});
await test('Explorer är en ren läsvy med direkta ägarappslänkar', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  for (const owner of ['../personer-familjer/', '../batregister/', '../fastigheter/', '../dokumentarkiv/', '../korpholmenrunt/', '../kartdata/']) assert.ok(app.includes(owner), owner);
  assert.match(app, /\?place=\$\{encodeURIComponent\(item\.id\)\}/);
  assert.match(app, /\?entry=\$\{encodeURIComponent\(item\.id\)\}/);
  assert.doesNotMatch(app, /putBatch|putBytes|replaceEntities|upsertFields|setField/);
});
await test('publiceringsbygget är datafritt och innehåller bara V2-Explorer', async () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr || result.stdout);
  const published = await readFile(resolve(REPO, 'explorer/src/app.js'), 'utf8');
  assert.match(published, /\.\.\/core\/active-app-bundle\.js/);
  await assert.rejects(readFile(resolve(REPO, 'explorer/src/projection.js'), 'utf8'));
});
console.log(`\n${passed} Explorer-V2-kontrakt godkända.`);
