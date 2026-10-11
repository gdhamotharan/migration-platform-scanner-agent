import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateReport } from '../src/reporting/json-reporter.js';

test('checked-in sample report is valid JSON with manifest-backed React evidence', async () => {
  const reportPath = fileURLToPath(new URL('../examples/sample-report.json', import.meta.url));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(validateReport(report), true);
  assert.equal(report.repository.name, 'sample-app');
  assert.ok(report.technologies.some((technology) => technology.technology === 'React'));
});
