import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scanRepository } from '../src/scanner.js';
import { validateReport } from '../src/reporting/json-reporter.js';

test('synthetic .NET solution reports separate targets, SDK constraints, package versions, and project links', async () => {
  const rootPath = fileURLToPath(new URL('../examples/dotnet-sample/', import.meta.url));
  const report = await scanRepository(rootPath);
  assert.equal(validateReport(report), true);
  assert.equal(report.analysis.status, 'completed');
  assert.equal(report.dotnet.projects.length, 2);
  assert.equal(report.dotnet.solution_memberships.length, 2);
  assert.equal(report.dotnet.solution_memberships.every((item) => item.status === 'resolved'), true);
  assert.equal(report.dotnet.projects.some((project) => project.project_references.some((reference) => reference.status === 'resolved')), true);
  assert.deepEqual(report.dotnet.projects.flatMap((project) => project.target_frameworks.map((item) => item.declared_value)).sort(), [
    'net6.0;net8.0', 'net8.0', 'net8.0;net9.0'
  ]);
  assert.equal(report.dotnet.sdk_constraints[0].declared_version, '8.0.200');
  assert.equal(report.dotnet.runtime.status, 'not_detected');
  assert.equal(report.dependencies.filter((item) => item.ecosystem === '.NET').length, 8);
  const aspnetPackage = report.dependencies.find((item) => item.name === 'Microsoft.AspNetCore.Authentication.JwtBearer');
  assert.deepEqual([aspnetPackage.declared_version, aspnetPackage.resolved_version, aspnetPackage.version_status], ['8.0.11', '8.0.11', 'resolved']);
  const aspnetFinding = report.technologies.find((item) => item.technology === 'ASP.NET Core' && item.version_scope === 'package');
  assert.equal(aspnetFinding.declared_version, '8.0.11');
  assert.equal(report.technologies.some((item) => item.category === 'runtime'), false);
  assert.ok(report.files.some((item) => item.path.endsWith('packages.lock.json') && item.file_format === 'JSON'));
  assert.ok(report.files.some((item) => item.path.endsWith('Directory.Packages.props') && item.category === 'dependency_manifest'));
  assert.equal(report.statistics.source_code_size_bytes, Buffer.byteLength('namespace Sample.Web;\n\npublic static class Program\n{\n    public static string ApplicationName => "Synthetic sample";\n}\n'));
  assert.equal(report.statistics.test_files, 1);
});
