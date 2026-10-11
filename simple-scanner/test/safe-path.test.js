import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isPathInside, toReportPath, readFileInsideRoot } from '../src/utils/safe-path.js';
import { sanitizeError } from '../src/utils/errors.js';

test('path containment rejects sibling prefixes and parent traversal', () => {
  const root = path.resolve('fixtures', 'app');
  assert.equal(isPathInside(root, path.join(root, 'src', 'main.js')), true);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'app-secrets', 'token.txt')), false);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'outside.txt')), false);
});

test('report paths are relative unless absolute paths are explicitly enabled', () => {
  const root = path.resolve('fixtures', 'app');
  const file = path.join(root, 'src', 'main.js');
  assert.equal(toReportPath(root, file), 'src/main.js');
  assert.equal(toReportPath(root, file, true), file);
});

test('sanitized errors contain neither absolute paths nor source-like error text', () => {
  const message = sanitizeError(new Error('parse failed near API_KEY=do-not-export'), 'src/package.json');
  assert.deepEqual(message, { code: 'SCAN_ERROR', message: 'Unable to process src/package.json.' });
});

test('safe manifest reads reject paths that resolve outside the repository', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-read-safe-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'scanner-read-outside-'));
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  await writeFile(path.join(root, 'package.json'), '{"name":"inside"}');
  await writeFile(path.join(outside, 'private.json'), '{"token":"must-not-be-read"}');
  assert.equal(await readFileInsideRoot(root, path.join(root, 'package.json')), '{"name":"inside"}');
  await assert.rejects(readFileInsideRoot(root, path.join(outside, 'private.json')), /outside/);
});
