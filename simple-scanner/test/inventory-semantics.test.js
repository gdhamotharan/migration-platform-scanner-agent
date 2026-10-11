import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { classifyFile } from '../src/repository/file-classifier.js';
import { scanRepository } from '../src/scanner.js';

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-inventory-semantics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('file classification separates source, tests, configuration, data, manifests, docs and assets', () => {
  const expected = [
    ['src/Program.cs', 'source_code', 'C#', null],
    ['tests/ProgramTests.cs', 'test_code', 'C#', null],
    ['appsettings.json', 'configuration', null, 'JSON'],
    ['seed/users.json', 'data', null, 'JSON'],
    ['Directory.Packages.props', 'dependency_manifest', null, 'XML'],
    ['README.md', 'documentation', null, 'Markdown'],
    ['assets/logo.png', 'static_asset', null, 'PNG']
  ];
  for (const [filePath, category, language, fileFormat] of expected) {
    const file = classifyFile(filePath);
    assert.deepEqual([file.category, file.language, file.fileFormat], [category, language, fileFormat], filePath);
  }
});

test('repository counters distinguish discovered, included, analyzed and policy-excluded files', async (t) => {
  const root = await temporaryRepository(t);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'tests'));
  const source = 'class Program { }\n';
  await writeFile(path.join(root, 'src', 'Program.cs'), source);
  await writeFile(path.join(root, 'tests', 'ProgramTests.cs'), 'class ProgramTests { }\n');
  await writeFile(path.join(root, 'appsettings.json'), JSON.stringify({ data: 'x'.repeat(1000) }));
  await writeFile(path.join(root, 'README.md'), 'Project notes\n');
  await writeFile(path.join(root, '.env'), 'API_TOKEN=not-read');

  const report = await scanRepository(root);
  const counts = report.repository.file_counts;
  assert.deepEqual({
    discovered: counts.files_discovered,
    included: counts.files_included,
    analyzed: counts.files_analyzed,
    excluded: counts.files_excluded,
    includedArrayLength: report.files.length
  }, { discovered: 5, included: 4, analyzed: 1, excluded: 1, includedArrayLength: 4 });
  assert.equal(report.analysis.status, 'completed');
  assert.equal(report.analysis.complete, true);
  assert.equal(report.statistics.source_code_size_bytes, Buffer.byteLength(source));
  assert.equal(report.statistics.source_code_lines, 1);
  assert.equal(report.statistics.configuration_files, 1);
  assert.equal(report.statistics.documentation_files, 1);
  assert.equal(report.statistics.test_files, 1);
  assert.equal(report.languages.some((item) => item.name === 'JSON' || item.name === 'Markdown'), false);
});

test('policy exclusions stay transparent without making the requested scan partial', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, '.env'), 'PRIVATE_VALUE');
  await writeFile(path.join(root, 'bundle.min.js'), 'generated');
  await writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2]));
  const report = await scanRepository(root);
  assert.equal(report.analysis.status, 'completed');
  assert.equal(report.analysis.complete, true);
  assert.equal(report.repository.file_counts.files_excluded, 3);
  assert.equal(report.repository.file_counts.directories_excluded, 0);
});

test('file-count limit reports the encountered skipped file and unknown remainder', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'a.cs'), 'class A {}');
  await writeFile(path.join(root, 'b.cs'), 'class B {}');
  await writeFile(path.join(root, 'c.cs'), 'class C {}');
  const report = await scanRepository(root, { maxFiles: 1 });
  assert.equal(report.analysis.status, 'partial');
  assert.equal(report.analysis.complete, false);
  assert.equal(report.repository.file_counts.files_included, report.files.length);
  assert.equal(report.repository.file_counts.unvisited_files_unknown, true);
  assert.ok(report.repository.file_counts.files_discovered >= 2);
  assert.ok(report.repository.file_counts.files_skipped >= 1);
});

test('unsupported resolution is a warning when all applicable checks finished', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'build.gradle'), 'dependencies { implementation "unsupported:static-only" }');
  const report = await scanRepository(root);
  assert.equal(report.analysis.status, 'completed_with_warnings');
  assert.equal(report.analysis.complete, true);
  assert.ok(report.warnings.some((item) => item.code === 'GRADLE_RESOLUTION_UNSUPPORTED'));
});

test('pre-aborted scans record cancellation and cancelled analyzer states', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'main.cs'), 'class Main {}');
  const controller = new AbortController();
  controller.abort();
  const report = await scanRepository(root, { signal: controller.signal });
  assert.equal(report.analysis.status, 'partial');
  assert.equal(report.analysis.complete, false);
  assert.equal(report.analysis.cancelled, true);
  assert.ok(report.analyzers.executions.every((item) => item.status === 'cancelled'));
});
