import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/reporting/report-builder.js';
import { serializeReport, validateReport } from '../src/reporting/json-reporter.js';

test('report builder emits a versioned allowlisted JSON schema with relative paths', () => {
  const report = buildReport({
    analysisId: 'test-id', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000, rootPath: 'C:/private/customer-app', options: {}, complete: true,
    files: [{ absolutePath: 'C:/private/customer-app/src/app.js', relativePath: 'src/app.js', sizeBytes: 4,
      extension: '.js', language: 'JavaScript', category: 'source_code', flags: { project: false, build: false, dependency: false, test: false, configuration: false, documentation: false }, sourceText: 'PRIVATE SOURCE' }],
    excludedItems: [{ relativePath: '.env', reason: 'sensitive_file', itemType: 'file' }],
    projects: [], analyzerResults: { language: { languages: [], statistics: { total_lines: 1 }, excluded_items: [], file_errors: [] }, dependencies: { dependencies: [], warnings: [], file_errors: [], incomplete: false }, technologies: [] },
    analyzerFailures: [], warnings: [], errors: []
  });
  const serialized = serializeReport(report);
  const parsed = JSON.parse(serialized);
  assert.equal(validateReport(parsed), true);
  assert.equal(parsed.schema_version, '2.0');
  assert.equal(parsed.analysis.status, 'completed');
  assert.equal(parsed.analysis.complete, true);
  assert.equal(parsed.repository.root_path, '.');
  assert.equal(parsed.files[0].path, 'src/app.js');
  assert.equal(parsed.repository.total_files, parsed.repository.file_counts.files_discovered);
  assert.equal(parsed.repository.file_counts.files_included, parsed.files.length);
  assert.equal(parsed.statistics.files_processed, parsed.repository.file_counts.files_analyzed);
  assert.equal(serialized.includes('C:/private'), false);
  assert.equal(serialized.includes('PRIVATE SOURCE'), false);

  const invalids = [
    (value) => { value.analysis.complete = false; },
    (value) => { value.analysis.completed_at = '2025-12-31T23:59:59.000Z'; },
    (value) => { value.repository.file_counts.files_discovered = -1; },
    (value) => { value.repository.file_counts.files_included += 1; },
    (value) => { value.technologies.push({ technology_id: 'react', technology: 'React', category: 'library', ecosystem: 'Node.js', detection_method: 'manifest_dependency', evidence_file_path: 'missing/package.json', evidence_type: 'manifest_dependency', confidence: 'manifest_declared', analyzer_id: 'technologies', analyzer_version: '1.0.0', explanation: 'Static evidence.' }); },
    (value) => { value.analyzers.counts.completed += 1; }
  ];
  for (const mutate of invalids) {
    const invalid = structuredClone(parsed);
    mutate(invalid);
    assert.throws(() => serializeReport(invalid), TypeError);
  }
});

test('report builder marks incomplete work as partial', () => {
  const report = buildReport({
    analysisId: 'partial-id', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000, rootPath: 'C:/repo', options: {}, complete: false, files: [], excludedItems: [], projects: [],
    analyzerResults: {}, analyzerFailures: [], warnings: [], errors: []
  });
  assert.equal(report.analysis.status, 'partial');
  assert.equal(report.analysis.complete, false);
});

test('report builder emits a failed state only with an error and never marks it complete', () => {
  const report = buildReport({
    analysisId: 'failed-id', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 10, rootPath: 'C:/repo', options: {}, complete: false, failed: true, files: [], excludedItems: [], projects: [],
    analyzerResults: {}, analyzerFailures: [], warnings: [], errors: []
  });
  assert.equal(validateReport(report), true);
  assert.equal(report.analysis.status, 'failed');
  assert.equal(report.analysis.complete, false);
  assert.equal(report.errors[0].code, 'SCAN_ERROR');
});
