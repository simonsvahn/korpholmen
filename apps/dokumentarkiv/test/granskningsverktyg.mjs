import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [app, styles, readme] = await Promise.all([
  readFile(resolve(ROOT, 'src/app.js'), 'utf8'),
  readFile(resolve(ROOT, 'styles.css'), 'utf8'),
  readFile(resolve(ROOT, 'README.md'), 'utf8'),
]);

assert.match(app, /const LOCAL_REVIEW_URL = 'http:\/\/127\.0\.0\.1:4317\/';/);
assert.match(app, /data-local-review-link/);
assert.match(app, /Starta granskningsverktyget\.command/);
assert.match(styles, /\.granskningsverktyg/);
assert.match(readme, /Markdown-filerna, originalen och läskopiorna publiceras inte/);

console.log('✓ Dokumentarkivet publicerar en datafri länk till det lokala granskningsverktyget.');
