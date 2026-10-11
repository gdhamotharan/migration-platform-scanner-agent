import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('CLI help and JSON format are runnable without global packages', async (t) => {
  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node src\/cli\.js scan <directory>/);

  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'main.js'), 'const value = 1;\n');
  const result = spawnSync(process.execPath, [cliPath, 'scan', root, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).analysis.status, 'completed');
  assert.match(result.stderr, /Scanning repository/);
  assert.match(result.stderr, /Scan completed/);
});

test('CLI rejects output inside the repository unless explicitly enabled', async (t) => {
  const root = await temporaryRepository(t);
  const sourcePath = path.join(root, 'source.js');
  const originalSource = 'const safe = true;';
  await writeFile(sourcePath, originalSource);
  const output = path.join(root, 'assessment.json');
  const rejected = spawnSync(process.execPath, [cliPath, 'scan', root, '--output', output], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /inside the scanned repository/);

  const allowed = spawnSync(process.execPath, [cliPath, 'scan', root, '--output', output, '--allow-output-in-repository'], { encoding: 'utf8' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).analysis.status, 'completed');

  const overwrite = spawnSync(process.execPath, [cliPath, 'scan', root, '--output', sourcePath, '--allow-output-in-repository'], { encoding: 'utf8' });
  assert.notEqual(overwrite.status, 0);
  assert.equal(await readFile(sourcePath, 'utf8'), originalSource);
});

test('CLI refuses an opted-in output path whose parent symlink escapes the repository', async (t) => {
  const root = await temporaryRepository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'scanner-cli-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linkPath = path.join(root, 'reports');
  try {
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Symlinks are unavailable: ${error.code}`);
    throw error;
  }
  const target = path.join(linkPath, 'assessment.json');
  const result = spawnSync(process.execPath, [cliPath, 'scan', root, '--output', target, '--allow-output-in-repository'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(outside, 'assessment.json')).then(() => true, () => false), false);
});

test('CLI returns nonzero with a concise message for a missing repository', () => {
  const missing = path.join(os.tmpdir(), `not-found-${Date.now()}`);
  const result = spawnSync(process.execPath, [cliPath, 'scan', missing], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist or is inaccessible/);
  assert.equal(result.stderr.includes(missing), false);
});

test('CLI reports a safe error and returns nonzero when the report cannot be written', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'source.js'), 'const value = 1;');
  const blockedParent = path.join(await mkdtemp(path.join(os.tmpdir(), 'scanner-cli-output-')), 'not-a-directory');
  t.after(() => rm(path.dirname(blockedParent), { recursive: true, force: true }));
  await writeFile(blockedParent, 'file blocks output directory');
  const result = spawnSync(process.execPath, [cliPath, 'scan', root, '--output', path.join(blockedParent, 'report.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /report could not be written/i);
  assert.equal(result.stderr.includes('file blocks output'), false);
});
