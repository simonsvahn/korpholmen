import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function listRelativeFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listRelativeFiles(resolve(directory, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

export async function assertExactPublicationFiles(directory, expectedFiles) {
  const actual = await listRelativeFiles(directory);
  const expected = [...new Set(expectedFiles)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter(file => !expectedSet.has(file));
  if (unexpected.length) throw new Error(`Vägrar publicera med oväntade filer: ${unexpected.join(', ')}`);
  const missing = expected.filter(file => !actualSet.has(file));
  if (missing.length) throw new Error(`Publiceringspaketet saknar: ${missing.join(', ')}`);
  return actual;
}
