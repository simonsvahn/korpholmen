import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const privateRoot = resolve(process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen');
const reviewRoot = resolve(process.argv[3] || join(process.cwd(), 'arbetsmaterial', 'batbildsgranskning-2026-08-16'));
const port = Number(process.argv[4] || 4334);
const v2Root = join(privateRoot, 'batregister-generation2');
const pointerPath = join(v2Root, 'active.json');
const imageRoot = join(privateRoot, 'batregister', 'bilder');
const sourceSheetRoot = resolve('/Users/simon/Dropbox/AI/Projekt/2 Wikis & källor/Wiki Korpholmen & släkten/källmaterial/07 KBK-arkivet/Båtar 2 - Scannade av Broder Peter-Pedal (Holm)');
const decisionsPath = join(reviewRoot, 'beslut.json');
const sha = value => createHash('sha256').update(value).digest('hex');

assert(privateRoot.endsWith('/Dropbox/Appar/Korpholmen'), `Oväntad privat rot: ${privateRoot}`);
assert(sourceSheetRoot.endsWith('/Båtar 2 - Scannade av Broder Peter-Pedal (Holm)'), `Oväntad källrot: ${sourceSheetRoot}`);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Ogiltig port');

const sourceSheetNames = new Set((await readdir(sourceSheetRoot)).filter(name => name.toLowerCase().endsWith('.pdf')));

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, () => false);

async function activeMaster() {
  const pointer = await json(pointerPath);
  assert.equal(pointer.app, 'batregister');
  assert(!pointer.master_relative_path.startsWith('/') && !pointer.master_relative_path.includes('..'), 'Ogiltig master_relative_path');
  const masterPath = join(v2Root, pointer.master_relative_path);
  const bytes = await readFile(masterPath);
  assert.equal(sha(bytes), pointer.master_sha256, 'Aktiv Båtmaster stämmer inte med active.json');
  const master = JSON.parse(bytes);
  assert.equal(master.master_revision, pointer.master_revision);
  return { pointer, master };
}

async function decisions() {
  if (!await exists(decisionsPath)) return { schema_version: 1, decisions: {} };
  const value = await json(decisionsPath);
  return { schema_version: 1, ...value, decisions: value.decisions || {} };
}

const decisionKey = (boatId, imageId) => `${boatId}:${imageId}`;
const obviousRemove = new Set([
  decisionKey('linje3', 'linje3-1'),
  decisionKey('linje3', 'linje3-lille-erik2-jpg'),
  decisionKey('igor', 'igor-1'),
  decisionKey('igor', 'igor-hilma2-jpg'),
  decisionKey('göstajansson', 'göstajansson-1'),
  decisionKey('snabbtuttillöarna', 'snabbtuttillöarna-snabbt-ut-till-oarna-el-linje-1-jpg'),
]);
const intentionalShared = new Set([
  decisionKey('piff', 'piff-piff-puff-register-1'),
  decisionKey('puff', 'puff-piff-puff-register-1'),
  decisionKey('öskaret', 'öskaret-1'),
  decisionKey('sviholmeni', 'sviholmeni-1'),
]);

const sourceAuditNotes = new Map([
  [decisionKey('linje3', 'linje3-1'), 'Hela bladet visar Lille Erik överst och Linje 3 nederst. Detta utsnitt är Lille Erik.'],
  [decisionKey('linje3', 'linje3-lille-erik2-jpg'), 'Dubblett av utsnittet med Lille Erik på det gemensamma bladet.'],
  [decisionKey('igor', 'igor-1'), 'Hela bladet visar Hilma överst och Igor nederst. Detta utsnitt är Hilma.'],
  [decisionKey('igor', 'igor-hilma2-jpg'), 'Dubblett av utsnittet med Hilma på det gemensamma bladet.'],
  [decisionKey('göstajansson', 'göstajansson-1'), 'Hela bladet visar Lilla Kräket överst och Gösta Jansson nederst. Detta utsnitt är Lilla Kräket.'],
  [decisionKey('snabbtuttillöarna', 'snabbtuttillöarna-snabbt-ut-till-oarna-el-linje-1-jpg'), 'Hela bladet visar Snabbt ut till öarna överst och Tojje nederst. Detta utsnitt är Tojje.'],
  [decisionKey('öskaret', 'öskaret-1'), 'Bladet anger både M/S Sviholmen I och R/S Öskaret; Öskaret syns på Sviholmen I.'],
  [decisionKey('sviholmeni', 'sviholmeni-1'), 'Bladet anger både M/S Sviholmen I och R/S Öskaret; fotografiet visar båda.'],
]);

function sourceSheetFor(imageSource) {
  const sourceFilename = basename(imageSource || '');
  const pdfFilename = sourceFilename.replace(/\.[^.]+$/, '.pdf');
  return sourceSheetNames.has(pdfFilename) ? pdfFilename : '';
}

function buildAudit(master, decisionDocument) {
  const boats = (master.data?.boats || []).filter(row => !row.deleted_at);
  const rows = boats.flatMap(boat => (boat.images || []).map((image, imageIndex) => {
    const full = image.full || image.thumb || {};
    const thumb = image.thumb || image.full || {};
    return {
      key: decisionKey(boat.id, image.id),
      boat_id: boat.id,
      boat_name: boat.display_name,
      image_id: image.id,
      image_index: imageIndex,
      full_sha256: full.sha256 || '',
      full_path: full.dropbox_path || '',
      preview_filename: basename(thumb.dropbox_path || full.dropbox_path || ''),
      source: image.source || '',
      source_filename: basename(image.source || ''),
      source_sheet_filename: sourceSheetFor(image.source),
      kind: image.kind || 'boat-photo',
      caption: image.caption || '',
    };
  }));
  const byHash = new Map();
  for (const row of rows) {
    if (!row.full_sha256) continue;
    if (!byHash.has(row.full_sha256)) byHash.set(row.full_sha256, []);
    byHash.get(row.full_sha256).push(row);
  }
  for (const row of rows) {
    row.explicit_decision = decisionDocument.decisions[row.key]?.decision || '';
  }
  for (const row of rows) {
    const shared = (byHash.get(row.full_sha256) || []).filter(item => item.key !== row.key && item.explicit_decision !== 'remove');
    row.shared_with = shared.map(item => ({ boat_id: item.boat_id, boat_name: item.boat_name, image_id: item.image_id }));
    row.classification = obviousRemove.has(row.key)
      ? 'obvious-error'
      : intentionalShared.has(row.key)
        ? 'intentional-shared'
        : shared.length
          ? 'shared-review'
          : 'unique';
    row.recommended_decision = obviousRemove.has(row.key) ? 'remove' : row.classification === 'shared-review' ? 'review' : 'keep';
    row.decision = row.explicit_decision || row.recommended_decision;
    row.note = decisionDocument.decisions[row.key]?.note || sourceAuditNotes.get(row.key) || '';
  }
  const priority = { 'obvious-error': 0, 'shared-review': 1, 'intentional-shared': 2, unique: 3 };
  rows.sort((left, right) => priority[left.classification] - priority[right.classification]
    || left.boat_name.localeCompare(right.boat_name, 'sv', { numeric: true })
    || left.image_index - right.image_index);
  return {
    master_revision: master.master_revision,
    generated_at: new Date().toISOString(),
    rows,
    summary: {
      boats: new Set(rows.map(row => row.boat_id)).size,
      images: rows.length,
      shared_files: [...byHash.values()].filter(group => group.length > 1).length,
      obvious_errors: rows.filter(row => row.classification === 'obvious-error').length,
      shared_review: rows.filter(row => row.classification === 'shared-review').length,
      decisions: Object.keys(decisionDocument.decisions).length,
    },
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function requestJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Begäran är för stor');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handle(request, response) {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/api/audit') {
    const [{ master }, decisionDocument] = await Promise.all([activeMaster(), decisions()]);
    return send(response, 200, JSON.stringify(buildAudit(master, decisionDocument)), 'application/json; charset=utf-8');
  }
  if (request.method === 'POST' && url.pathname === '/api/decision') {
    const input = await requestJson(request);
    assert(['keep', 'remove', 'review'].includes(input.decision), 'Ogiltigt beslut');
    const [{ master }, decisionDocument] = await Promise.all([activeMaster(), decisions()]);
    const audit = buildAudit(master, decisionDocument);
    const row = audit.rows.find(item => item.boat_id === input.boat_id && item.image_id === input.image_id);
    assert(row, 'Bildposten finns inte i aktiv Båtmaster');
    const key = decisionKey(input.boat_id, input.image_id);
    decisionDocument.decisions[key] = {
      boat_id: input.boat_id,
      boat_name: row.boat_name,
      image_id: input.image_id,
      decision: input.decision,
      note: String(input.note || '').slice(0, 500),
      decided_at: new Date().toISOString(),
      decided_by: 'simon',
    };
    decisionDocument.updated_at = new Date().toISOString();
    await writeJsonAtomic(decisionsPath, decisionDocument);
    return send(response, 200, JSON.stringify({ ok: true, key, decision: input.decision }), 'application/json; charset=utf-8');
  }
  if (request.method === 'GET' && url.pathname.startsWith('/bilder/')) {
    const filename = basename(decodeURIComponent(url.pathname.slice('/bilder/'.length)));
    if (!/^[a-f0-9]{64}\.(?:jpe?g|png|webp)$/i.test(filename)) return send(response, 400, 'Ogiltigt bildnamn');
    const bytes = await readFile(join(imageRoot, filename));
    const contentType = extname(filename).toLowerCase() === '.png' ? 'image/png' : extname(filename).toLowerCase() === '.webp' ? 'image/webp' : 'image/jpeg';
    return send(response, 200, bytes, contentType);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/kallblad/')) {
    const filename = basename(decodeURIComponent(url.pathname.slice('/kallblad/'.length)));
    if (!sourceSheetNames.has(filename) || !filename.toLowerCase().endsWith('.pdf')) return send(response, 404, 'Källbladet saknas');
    return send(response, 200, await readFile(join(sourceSheetRoot, filename)), 'application/pdf');
  }
  const staticFile = url.pathname === '/' ? 'index.html' : basename(url.pathname);
  if (!['index.html', 'app.js', 'styles.css'].includes(staticFile)) return send(response, 404, 'Saknas');
  const contentType = staticFile.endsWith('.js') ? 'text/javascript; charset=utf-8' : staticFile.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
  return send(response, 200, await readFile(join(reviewRoot, staticFile)), contentType);
}

const server = createServer((request, response) => handle(request, response).catch(error => {
  console.error(error);
  send(response, 500, error.message);
}));
server.listen(port, '127.0.0.1', () => console.log(`Båtbildsgranskning: http://127.0.0.1:${port}/`));
