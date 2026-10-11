import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { scanRepository } from '../src/scanner.js';
import { AnalyzerRegistry } from '../src/analyzers/analyzer-registry.js';
import { validateReport } from '../src/reporting/json-reporter.js';

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scanner inventories a local Node project, detects React and excludes secrets from its report', async (t) => {
  const rootPath = await temporaryRepository(t);
  const source = "const credential = 'SOURCE_SNIPPET_MUST_NOT_APPEAR';\nexport default credential;\n";
  const secret = 'API_TOKEN=FAKE_SECRET_VALUE_12345';
  await mkdir(path.join(rootPath, 'src'));
  await mkdir(path.join(rootPath, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ name: 'sample-app', dependencies: { react: '^18.2.0' } }));
  await writeFile(path.join(rootPath, 'src', 'index.js'), source);
  await writeFile(path.join(rootPath, '.env'), secret);
  await writeFile(path.join(rootPath, 'node_modules', 'pkg', 'index.js'), 'excluded');

  const report = await scanRepository(rootPath);
  const serialized = JSON.stringify(report);
  assert.equal(validateReport(report), true);
  assert.equal(report.analysis.status, 'completed');
  assert.equal(report.analysis.complete, true);
  assert.equal(report.repository.total_files, 3);
  assert.equal(report.repository.total_size_bytes, Buffer.byteLength(source) + Buffer.byteLength(secret) + Buffer.byteLength(JSON.stringify({ name: 'sample-app', dependencies: { react: '^18.2.0' } })));
  assert.ok(report.projects.some((project) => project.project_type === 'Node.js project'));
  assert.ok(report.technologies.some((technology) => technology.technology === 'React' && technology.evidence_file_path === 'package.json'));
  assert.ok(report.dependencies.some((dependency) => dependency.name === 'react'));
  assert.ok(report.excluded_items.some((item) => item.path === 'node_modules' && item.reason === 'excluded_directory'));
  assert.ok(report.excluded_items.some((item) => item.path === '.env' && item.reason === 'sensitive_file'));
  assert.equal(serialized.includes(source), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('FAKE_SECRET_VALUE_12345'), false);
  assert.equal(report.repository.root_path, '.');
});

test('file and manifest limits produce partial reports instead of claiming completion', async (t) => {
  const rootPath = await temporaryRepository(t);
  await writeFile(path.join(rootPath, 'a.js'), 'const a = 1;');
  await writeFile(path.join(rootPath, 'b.js'), 'const b = 2;');
  const limited = await scanRepository(rootPath, { maxFiles: 1 });
  assert.equal(limited.analysis.status, 'partial');
  assert.equal(limited.analysis.complete, false);
  assert.ok(limited.warnings.some((warning) => warning.code === 'MAX_FILES_REACHED'));

  await writeFile(path.join(rootPath, 'package.json'), '{ bad manifest');
  const malformed = await scanRepository(rootPath);
  assert.equal(malformed.analysis.status, 'partial');
  assert.equal(malformed.analysis.complete, false);
  assert.ok(malformed.errors.some((error) => error.code === 'MANIFEST_PARSE_FAILED'));
});

test('reaching the file-size cap is reported as a partial scan', async (t) => {
  const rootPath = await temporaryRepository(t);
  await writeFile(path.join(rootPath, 'large.js'), '123456789');
  const report = await scanRepository(rootPath, { maxFileSizeBytes: 4 });
  assert.equal(report.analysis.status, 'partial');
  assert.equal(report.analysis.complete, false);
  assert.ok(report.excluded_items.some((item) => item.path === 'large.js' && item.reason === 'file_too_large'));
  assert.equal(report.warnings.filter((item) => item.code === 'FILE_TOO_LARGE').length, 1);
});

test('NUL-containing files produce one binary exclusion record', async (t) => {
  const rootPath = await temporaryRepository(t);
  await writeFile(path.join(rootPath, 'odd.cs'), Buffer.from('plain\0binary-ish'));
  const report = await scanRepository(rootPath);
  assert.equal(report.excluded_items.filter((item) => item.path === 'odd.cs' && item.reason === 'binary_content').length, 1);
});

test('one failing analyzer does not erase successful results in the scan report', async (t) => {
  const rootPath = await temporaryRepository(t);
  await writeFile(path.join(rootPath, 'main.js'), 'line\n');
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'language', version: '1.0.0', analyze: async () => ({
    languages: [{ name: 'JavaScript', file_count: 1, size_bytes: 5, lines: 1, blank_lines: 0 }],
    statistics: { files_processed: 1, total_source_size_bytes: 5, total_lines: 1, blank_lines: 0, comment_lines: null }
  }) });
  registry.register({ id: 'dependencies', version: '1.0.0', analyze: async () => ({ dependencies: [], manifest_facts: [], warnings: [], file_errors: [], incomplete: false }) });
  registry.register({ id: 'technologies', version: '1.0.0', analyze: async () => { throw new Error('secret text'); } });

  const report = await scanRepository(rootPath, { analyzerRegistry: registry });
  assert.equal(report.languages[0].name, 'JavaScript');
  assert.equal(report.analysis.status, 'partial');
  assert.equal(report.errors[0].code, 'ANALYZER_FAILED');
  assert.equal(JSON.stringify(report).includes('secret text'), false);
});

test('invalid repository paths fail clearly before analysis begins', async (t) => {
  const parent = await temporaryRepository(t);
  await assert.rejects(scanRepository(path.join(parent, 'missing')), (error) => {
    assert.equal(error.name, 'ScanStartError');
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /does not exist or is inaccessible/);
    return true;
  });
  const filePath = path.join(parent, 'file.txt');
  await writeFile(filePath, 'not a directory');
  await assert.rejects(scanRepository(filePath), (error) => {
    assert.equal(error.code, 'ENOTDIR');
    return true;
  });
});
