import test from 'node:test';
import assert from 'node:assert/strict';
import { TechnologyAnalyzer, TECHNOLOGY_RULES } from '../src/analyzers/technology-analyzer.js';

test('technology rules report normalized manifest evidence without conflating package and runtime versions', async () => {
  const manifestFacts = [
    { manifest_path: 'web/package.json', ecosystem: 'Node.js', parse_status: 'parsed' },
    { manifest_path: 'java/pom.xml', ecosystem: 'Maven', parse_status: 'parsed' },
    { manifest_path: 'python/requirements.txt', ecosystem: 'Python', parse_status: 'parsed' }
  ];
  const dotnetProject = { project_id: 'project-000000000000000000000001', manifest_path: 'dotnet/App.csproj', target_frameworks: [
    { declared_value: 'net8.0', evidence_file_path: 'dotnet/App.csproj', condition: null }
  ], framework_references: [{ name: 'Microsoft.AspNetCore.App', evidence_file_path: 'dotnet/App.csproj', condition: null }] };
  const result = await new TechnologyAnalyzer().analyze({ results: {
    dependencies: { manifest_facts: manifestFacts, dependencies: [
      { name: 'react', version: '^18.2.0', manifest_path: 'web/package.json', ecosystem: 'Node.js' },
      { name: 'org.springframework.boot:spring-boot-starter-web', version: '3.2.0', manifest_path: 'java/pom.xml', ecosystem: 'Maven' },
      { name: 'Django', version: '>=4.2', manifest_path: 'python/requirements.txt', ecosystem: 'Python' }
    ] },
    dotnet: { dependencies: [
      { project_id: dotnetProject.project_id, name: 'Microsoft.AspNetCore.Authentication.JwtBearer', declared_version: '8.0.11', manifest_path: 'dotnet/App.csproj' }
    ], projects: [dotnetProject] }
  } });
  const byName = new Map(result.map((finding) => [finding.technology, finding]));
  assert.equal(TECHNOLOGY_RULES.length >= 4, true);
  assert.equal(byName.get('React').declared_version, '^18.2.0');
  assert.equal(byName.get('Spring Boot').evidence_file_path, 'java/pom.xml');
  assert.equal(byName.get('Django').confidence, 'manifest_declared');
  assert.ok(result.some((finding) => finding.technology === 'ASP.NET Core'
    && finding.detection_method === 'manifest_dependency' && finding.declared_version === '8.0.11' && finding.version_scope === 'package'));
  assert.ok(result.some((finding) => finding.technology === 'ASP.NET Core' && finding.detection_method === 'framework_reference'));
  assert.equal(byName.get('.NET target framework net8.0').declared_value, 'net8.0');
  assert.equal(result.some((finding) => finding.declared_version === '8.0.11' && finding.version_scope !== 'package'), false);
});

test('technology analyzer does not infer frameworks from unrelated paths or text', async () => {
  const result = await new TechnologyAnalyzer().analyze({ results: { dependencies: { manifest_facts: [
    { manifest_path: 'docs/react-notes.md', ecosystem: 'unknown', dependencies: [{ name: 'some-library', version: '1.0' }] }
  ] } } });
  assert.deepEqual(result, []);
});
