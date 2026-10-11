import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { classifyFile } from '../src/repository/file-classifier.js';
import { DependencyAnalyzer } from '../src/analyzers/dependency-analyzer.js';

async function addManifest(rootPath, relativePath, text) {
  const absolutePath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
  return { ...classifyFile(relativePath), absolutePath, relativePath, sizeBytes: Buffer.byteLength(text) };
}

test('dependency analyzer extracts direct declarations from supported manifests and flags Gradle limits', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-dependencies-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const fakeCredential = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const files = await Promise.all([
    addManifest(rootPath, 'web/package.json', JSON.stringify({
      dependencies: { react: '^18.2.0', internal: fakeCredential }, devDependencies: { vitest: '^1.0.0' }, optionalDependencies: { sharp: '*' }
    })),
    addManifest(rootPath, 'requirements.txt', 'Django>=4.2,<5\nrequests==2.31.0\n--editable git+https://example.invalid/repo\n'),
    addManifest(rootPath, 'python/pyproject.toml', '[project]\ndependencies = ["fastapi>=0.100", "uvicorn"]\n[project.optional-dependencies]\ndev = ["pytest>=7"]\n'),
    addManifest(rootPath, 'poetry/pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\n[tool.poetry.group.test.dependencies]\npytest = "^7.4"\n'),
    addManifest(rootPath, 'dotnet/App.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.1" /><PackageReference Include="xunit"><Version>2.6.0</Version></PackageReference></ItemGroup></Project>'),
    addManifest(rootPath, 'java/pom.xml', '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.2.0</version></dependency><dependency><groupId>org.example</groupId><artifactId>legacy</artifactId></dependency></dependencies></project>'),
    addManifest(rootPath, 'gradle/build.gradle', 'dependencies { implementation "org.example:library:1.0" }')
  ]);

  const result = await new DependencyAnalyzer().analyze({ rootPath, files, options: {} });
  const dependency = (name) => result.dependencies.find((item) => item.name === name);
  assert.deepEqual([dependency('react').version, dependency('react').classification], ['^18.2.0', 'direct']);
  assert.equal(dependency('vitest').development, true);
  assert.equal(dependency('sharp').classification, 'optional');
  assert.deepEqual([dependency('internal').version, dependency('internal').parse_status], [null, 'unparsed']);
  assert.equal(JSON.stringify(result).includes(fakeCredential), false);
  assert.deepEqual([dependency('Django').version, dependency('Django').ecosystem], ['>=4.2,<5', 'Python']);
  assert.equal(dependency('requests').manifest_path, 'poetry/pyproject.toml');
  assert.equal(dependency('pytest').development, true);
  assert.equal(dependency('Newtonsoft.Json').version, '13.0.1');
  assert.equal(dependency('xunit').version, '2.6.0');
  assert.equal(dependency('org.springframework.boot:spring-boot-starter-web').version, '3.2.0');
  assert.equal(dependency('org.example:legacy').version_unresolved, true);
  assert.equal(result.dependencies.some((item) => item.name === 'library'), false);
  assert.ok(result.warnings.some((warning) => warning.code === 'GRADLE_RESOLUTION_UNSUPPORTED'));
  assert.ok(result.dependencies.some((item) => item.parse_status === 'unparsed'));
  assert.equal(result.incomplete, true);
});

test('malformed manifests are isolated, marked incomplete, and never echo their text', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-malformed-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const secret = 'API_TOKEN=must-not-leak';
  const file = await addManifest(rootPath, 'package.json', `{"dependencies": ${secret}`);
  const result = await new DependencyAnalyzer().analyze({ rootPath, files: [file], options: {} });
  assert.equal(result.incomplete, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('malformed TOML, XML entity declarations, and credential-bearing requirements fail closed', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-adversarial-manifests-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const tomlSecret = 'TOML_PRIVATE_MARKER_443322';
  const xmlSecret = 'XML_PRIVATE_MARKER_554433';
  const requirementsSecret = 'REQUIREMENTS_PRIVATE_MARKER_665544';
  const files = await Promise.all([
    addManifest(rootPath, 'good/package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } })),
    addManifest(rootPath, 'bad/pyproject.toml', `[project]\ndependencies = ["requests>=2.0"\n${tomlSecret}\n`),
    addManifest(rootPath, 'dotnet/Evil.csproj', `<!DOCTYPE Project [<!ENTITY leaked "${xmlSecret}">]><Project><ItemGroup><PackageReference Include="safe-package" Version="1.0.0" /></ItemGroup></Project>`),
    addManifest(rootPath, 'requirements.txt', `click==8.1.7\n--extra-index-url https://user:${requirementsSecret}@example.invalid/simple\n`)
  ]);

  const result = await new DependencyAnalyzer().analyze({ rootPath, files, options: {} });
  const serialized = JSON.stringify(result);
  assert.ok(result.dependencies.some((item) => item.name === 'lodash' && item.parse_status === 'parsed'));
  assert.ok(result.dependencies.some((item) => item.name === 'click' && item.version === '==8.1.7'));
  assert.ok(result.dependencies.some((item) => item.parse_status === 'unparsed'));
  assert.ok(result.warnings.some((item) => item.code === 'MANIFEST_PARSE_FAILED' && item.file_path === 'bad/pyproject.toml'));
  assert.ok(result.warnings.some((item) => item.code === 'MANIFEST_PARSE_FAILED' && item.file_path === 'dotnet/Evil.csproj'));
  assert.equal(result.incomplete, true);
  assert.equal(serialized.includes(tomlSecret), false);
  assert.equal(serialized.includes(xmlSecret), false);
  assert.equal(serialized.includes(requirementsSecret), false);
});
