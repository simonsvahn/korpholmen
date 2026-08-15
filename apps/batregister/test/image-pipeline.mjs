import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../../../packages/core/data-layer.js';
import {
  fitImageDimensions,
  imageBlobMatchesSha256,
  imageBlobSha256,
  prepareImageForStorage,
  uploadPendingImageBlobs,
} from '../src/image-pipeline.js';

let passed = 0;
async function test(name, action) {
  await action();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test('bilddimensioner skalas proportionellt och förstoras aldrig', () => {
  assert.deepEqual(fitImageDimensions(5000, 2500, 2500), { width: 2500, height: 1250, resized: true });
  assert.deepEqual(fitImageDimensions(800, 600, 2500), { width: 800, height: 600, resized: false });
});

await test('bildblobbar identifieras och avvisas när kontrollsumman inte stämmer', async () => {
  const blob = new Blob(['Atterbom']);
  const digest = await imageBlobSha256(blob);
  assert.equal(digest, '4c52fcb34d380ffb5cfd6f446e93e132754d98b6d3fd7df3208022f16270d634');
  assert.equal(await imageBlobMatchesSha256(blob, digest), true);
  assert.equal(await imageBlobMatchesSha256(blob, '0'.repeat(64)), false);
  assert.equal(await imageBlobMatchesSha256(blob, ''), true);
});

await test('stora bilder orienteras, skalas ned och kodas om före lagring', async () => {
  let drawArguments = null;
  let bitmapClosed = false;
  const input = new Blob(['stor originalbild'], { type: 'image/jpeg' });
  const prepared = await prepareImageForStorage(input, {
    maxDimension: 2560,
    createImageBitmapImpl: async (_file, options) => {
      assert.deepEqual(options, { imageOrientation: 'from-image' });
      return { width: 4000, height: 2000, close: () => { bitmapClosed = true; } };
    },
    createCanvas: (width, height) => ({
      getContext: () => ({
        fillStyle: '',
        fillRect: () => {},
        drawImage: (...args) => { drawArguments = args; },
      }),
      toBlob: (callback, type, quality) => {
        assert.equal(type, 'image/jpeg');
        assert.equal(quality, 0.86);
        callback(new Blob(['nedskalad'], { type }));
      },
      width,
      height,
    }),
  });
  assert.equal(prepared.width, 2560);
  assert.equal(prepared.height, 1280);
  assert.equal(prepared.originalWidth, 4000);
  assert.equal(prepared.resized, true);
  assert.equal(prepared.extension, 'jpg');
  assert.deepEqual(drawArguments.slice(1), [0, 0, 2560, 1280]);
  assert.equal(bitmapClosed, true);
});

await test('en bild som redan ryms behålls utan omkodning', async () => {
  const input = new Blob(['liten bild'], { type: 'image/png' });
  const prepared = await prepareImageForStorage(input, {
    createImageBitmapImpl: async () => ({ width: 1200, height: 800, close: () => {} }),
    createCanvas: () => { throw new Error('canvas ska inte användas'); },
  });
  assert.equal(prepared.blob, input);
  assert.equal(prepared.resized, false);
  assert.equal(prepared.extension, 'png');
});

await test('bildkön återförsöker tillfälliga fel och isolerar en permanent trasig fil', async () => {
  const store = new MemoryStore();
  await store.putBlob('/bilder/giltig.jpg', new Blob(['giltig']), { pendingUpload: true });
  await store.putBlob('/bilder/trasig.jpg', new Blob(['trasig']), { pendingUpload: true });
  await store.putBlob('/bilder/tillfallig.jpg', new Blob(['tillfällig']), { pendingUpload: true });
  const attempts = new Map();
  const transport = {
    async putBlobImmutable(path) {
      attempts.set(path, (attempts.get(path) || 0) + 1);
      if (path.endsWith('trasig.jpg')) throw Object.assign(new Error('felaktig bild'), { status: 400 });
      if (path.endsWith('tillfallig.jpg') && attempts.get(path) === 1) throw new TypeError('nätverket bröts');
    },
  };
  const result = await uploadPendingImageBlobs({ store, transport, sleep: async () => {} });
  assert.equal(result.uploaded, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].path, '/bilder/trasig.jpg');
  assert.equal(attempts.get('/bilder/giltig.jpg'), 1);
  assert.equal(attempts.get('/bilder/trasig.jpg'), 1);
  assert.equal(attempts.get('/bilder/tillfallig.jpg'), 2);
  assert.deepEqual((await store.listPendingBlobs()).map(entry => entry.key), ['/bilder/trasig.jpg']);
});

await test('operationssynken körs före bildfaserna och startbildsframsteg sparas per fil', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const syncSource = source.slice(source.indexOf('async function syncNow()'));
  const operations = syncSource.indexOf('new SyncEngine({repository,transport}).syncOnce()');
  const bootstrapImages = syncSource.indexOf('uploadBootstrapImages(transport)');
  const queuedImages = syncSource.indexOf('uploadPendingImageBlobs({store,transport');
  assert.ok(operations >= 0 && operations < bootstrapImages && bootstrapImages < queuedImages);
  assert.match(source, /completed_paths:\[\.\.\.completed\]/);
  assert.match(source, /failures\.push\(\{path:file\.dropbox_path/);
  assert.match(source, /data-image-sha256/);
  assert.match(source, /imageBlobMatchesSha256\(blob, expectedSha256\)/);
});

console.log(`\n${passed} bildpipeline-kontrakt godkända.`);
