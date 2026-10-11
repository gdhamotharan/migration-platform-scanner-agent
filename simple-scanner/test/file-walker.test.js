import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { walkRepository } from '../src/repository/file-walker.js';
import { classifyFile } from '../src/repository/file-classifier.js';

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-scanner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('walker inventories nested files and excludes default and configured directories', async (t) => {
  const root = await temporaryRepository(t);
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, 'custom-output'), { recursive: true });
  await writeFile(path.join(root, 'src', 'nested', 'main.ts'), 'const value: number = 1;\n');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
  await writeFile(path.join(root, 'custom-output', 'build.js'), 'ignored');

  const events = [];
  for await (const event of walkRepository(root, { excludeDirs: ['custom-output'] })) events.push(event);

  assert.deepEqual(events.filter((event) => event.type === 'file').map((event) => event.relativePath), ['src/nested/main.ts']);
  assert.ok(events.some((event) => event.type === 'excluded' && event.relativePath === 'node_modules' && event.reason === 'excluded_directory'));
  assert.ok(events.some((event) => event.type === 'excluded' && event.relativePath === 'custom-output' && event.reason === 'excluded_directory'));
  assert.equal(events.find((event) => event.type === 'file').language, 'TypeScript');
});

test('walker reports oversized, sensitive, generated and binary files without reading them', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'large.js'), '123456789');
  await writeFile(path.join(root, '.env'), 'PASSWORD=should-not-be-read');
  await writeFile(path.join(root, 'bundle.min.js'), 'generated');
  await writeFile(path.join(root, 'picture.png'), Buffer.from([0, 1, 2]));

  const events = [];
  for await (const event of walkRepository(root, { maxFileSizeBytes: 5 })) events.push(event);
  const skipped = new Map(events.filter((event) => event.type === 'excluded').map((event) => [event.relativePath, event.reason]));
  assert.equal(skipped.get('large.js'), 'file_too_large');
  assert.equal(skipped.get('.env'), 'sensitive_file');
  assert.equal(skipped.get('bundle.min.js'), 'generated_artifact');
  assert.equal(skipped.get('picture.png'), 'binary_file');
  assert.equal(JSON.stringify(events).includes('should-not-be-read'), false);
  const secretFile = events.find((event) => event.type === 'excluded' && event.relativePath === '.env');
  assert.equal(secretFile.itemType, 'file');
  assert.equal(secretFile.sizeBytes, Buffer.byteLength('PASSWORD=should-not-be-read'));
});

test('walker stops at the configured file count and reports the scan limit', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'a.js'), 'a');
  await writeFile(path.join(root, 'b.js'), 'b');
  await writeFile(path.join(root, 'c.js'), 'c');

  const events = [];
  for await (const event of walkRepository(root, { maxFiles: 2 })) events.push(event);
  assert.equal(events.filter((event) => event.type === 'file').length, 2);
  assert.deepEqual(events.at(-1), {
    type: 'limit', reason: 'max_files', limit: 2, relativePath: 'c.js',
    itemType: 'file', sizeBytes: 1, category: 'source_code'
  });
});

test('walker never follows symbolic links outside the selected root', async (t) => {
  const root = await temporaryRepository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'scanner-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.js'), 'must not be read');
  try {
    await symlink(outside, path.join(root, 'external'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation is unavailable');
    throw error;
  }

  const events = [];
  for await (const event of walkRepository(root)) events.push(event);
  assert.equal(events.some((event) => event.type === 'file' && event.relativePath.includes('secret.js')), false);
  assert.ok(events.some((event) => event.type === 'excluded' && event.relativePath === 'external' && event.reason === 'symlink_not_followed'));
});

test('classification recognizes project, dependency, test, build and documentation files', () => {
  assert.deepEqual(classifyFile('packages/web/package.json').flags, {
    project: true, build: false, dependency: true, test: false, configuration: false, documentation: false
  });
  assert.equal(classifyFile('src/widget.test.ts').flags.test, true);
  assert.equal(classifyFile('README.md').flags.documentation, true);
  assert.equal(classifyFile('build.gradle.kts').flags.build, true);
  assert.equal(classifyFile('types/index.d.ts').language, 'TypeScript');
});
