import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = resolve(ROOT, 'verktyg');
const releaseConfig = JSON.parse(await readFile(resolve(TOOLS, 'release.json'), 'utf8'));
const RELEASE = String(releaseConfig.release || '');
if (!/^\d{4}-\d{2}-\d{2}-korpholmen-pwa-\d+$/.test(RELEASE)) throw new Error('Ogiltig release i verktyg/release.json');
const APP_DIRECTORIES = ['matrikel', 'batregister', 'fastigheter', 'dokumentarkiv', 'korpholmenrunt', 'klubbhistorik', 'kartdata'];
const ROOT_SHELL = ['index.html', 'styles.css', 'app-switcher.css', 'manifest.webmanifest', 'icons/korpholmen.svg', 'icons/korpholmen-180.png', 'icons/korpholmen-192.png', 'icons/korpholmen-512.png', 'src/app.js', 'src/app-family-bootstrap.js', 'src/config.js', 'sw.js'];
const ENTRY_HTML = [resolve(ROOT, 'index.html'), ...APP_DIRECTORIES.flatMap(directory => [resolve(ROOT, 'apps', directory, 'index.html'), resolve(ROOT, directory, 'index.html')])];
const PRECACHE_EXCLUSIONS = [/\/(?:og\.png)$/i];

const workerTemplate = await readFile(resolve(TOOLS, 'sw.template.js'), 'utf8');
if (!workerTemplate.includes('__KORPHOLMEN_RELEASE__')) throw new Error('Service worker-mallen saknar releaseplatshållare');
await writeFile(resolve(ROOT, 'sw.js'), workerTemplate.replaceAll('__KORPHOLMEN_RELEASE__', RELEASE));

for (const path of ENTRY_HTML) {
  const html = await readFile(path, 'utf8');
  const versioned = html.replace(/\?v=[^"'\s<>&]+/g, `?v=${RELEASE}`);
  if (versioned !== html) await writeFile(path, versioned);
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

for (const file of ROOT_SHELL) if (!(await stat(resolve(ROOT, file))).isFile()) throw new Error(`Korpholmens appskal saknar ${file}`);

const appFiles = (await Promise.all(APP_DIRECTORIES.map(directory => listFiles(resolve(ROOT, directory))))).flat()
  .map(path => relative(ROOT, path))
  .filter(path => /\.(?:html|css|js|webmanifest|svg|png)$/.test(path))
  .filter(path => !PRECACHE_EXCLUSIONS.some(expression => expression.test(`/${path}`)));
const coreFiles = (await listFiles(resolve(ROOT, 'packages/core')))
  .map(path => relative(ROOT, path))
  .filter(path => path.endsWith('.js') && !path.includes('/test/'));
const shellFiles = [...new Set([...ROOT_SHELL, ...appFiles, ...coreFiles])].sort().map(path => `./${path}`);

for (const directory of APP_DIRECTORIES) {
  const html = await readFile(resolve(ROOT, directory, 'index.html'), 'utf8');
  if (!html.includes('href="../manifest.webmanifest"')) throw new Error(`${directory} använder inte Korpholmens gemensamma manifest`);
  if (!html.includes('src="../src/app-family-bootstrap.js')) throw new Error(`${directory} saknar Korpholmens gemensamma bootstrap`);
}

const release = {
  release: RELEASE,
  generated_at: releaseConfig.generated_at,
  pwa: { id: './', scope: './', start_url: './' },
  apps: APP_DIRECTORIES,
  shell_files: shellFiles,
};
await writeFile(resolve(ROOT, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`Korpholmens gemensamma appskal byggt: ${shellFiles.length} filer i ${APP_DIRECTORIES.length} appar.`);
