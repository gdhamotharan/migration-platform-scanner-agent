import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { scanRepository } from '../src/scanner.js';

async function temporaryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scanner-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function hashesUnder(root, relative = '') {
  const directory = path.join(root, relative);
  const output = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [name, hash] of await hashesUnder(root, child)) output.set(name, hash);
    } else if (entry.isFile()) {
      const content = await readFile(path.join(root, child));
      output.set(child, createHash('sha256').update(content).digest('hex'));
    }
  }
  return output;
}

test('mixed repositories retain source hashes and reports contain no source or fake secrets', async (t) => {
  const root = await temporaryRepository(t);
  const secret = 'PRIVATE_TOKEN=FAKE_SECRET_VALUE_998877';
  const snippet = "const marker = 'SOURCE_SNIPPET_PRIVATE';";
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'dotnet'));
  await mkdir(path.join(root, 'java'));
  await mkdir(path.join(root, 'tests'));
  await mkdir(path.join(root, 'node_modules', 'hidden'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"mixed-app","dependencies":{"react":"^18.2.0"}}');
  await writeFile(path.join(root, 'src', 'main.js'), snippet);
  await writeFile(path.join(root, '.env'), secret);
  await writeFile(path.join(root, 'App.sln'), '');
  await writeFile(path.join(root, 'dotnet', 'App.csproj'), '<Project><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /></ItemGroup></Project>');
  await writeFile(path.join(root, 'java', 'pom.xml'), '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.2.0</version></dependency></dependencies></project>');
  await writeFile(path.join(root, 'requirements.txt'), 'Django==5.0.1\n');
  await writeFile(path.join(root, 'tests', 'test_app.py'), 'def test_ok():\n    assert True\n');
  await writeFile(path.join(root, 'node_modules', 'hidden', 'x.js'), 'must be excluded');
  const before = await hashesUnder(root);

  const report = await scanRepository(root);
  const after = await hashesUnder(root);
  assert.deepEqual(after, before);
  assert.ok(report.projects.some((project) => project.ecosystem === 'Node.js'));
  assert.ok(report.projects.some((project) => project.ecosystem === '.NET'));
  assert.ok(report.projects.some((project) => project.ecosystem === 'Maven'));
  assert.ok(report.projects.some((project) => project.ecosystem === 'Python'));
  assert.deepEqual(new Set(report.technologies.map((technology) => technology.technology)), new Set(['React', 'ASP.NET Core', 'Spring Boot', 'Django']));
  assert.equal(report.files.find((file) => file.path === 'tests/test_app.py').is_test_file, true);
  assert.ok(report.excluded_items.some((item) => item.path === '.env'));
  assert.ok(report.excluded_items.some((item) => item.path === 'node_modules'));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('FAKE_SECRET_VALUE_998877'), false);
  assert.equal(serialized.includes(snippet), false);
});

test('scanner makes no HTTP, HTTPS, socket, or fetch requests', async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(path.join(root, 'main.js'), 'const value = 1;\n');
  const methods = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect']
  ];
  const originals = methods.map(([module, key]) => [module, key, module[key]]);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const blocked = () => { requests += 1; throw new Error('network call blocked by test'); };
  try {
    for (const [module, key] of methods) module[key] = blocked;
    globalThis.fetch = blocked;
    await scanRepository(root);
  } finally {
    for (const [module, key, original] of originals) module[key] = original;
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests, 0);
});

test('report paths redact secret-like filename segments', async (t) => {
  const root = await temporaryRepository(t);
  const marker = 'API_TOKEN=FAKE_SECRET_PATH_VALUE_998877';
  await writeFile(path.join(root, `${marker}.js`), 'const value = 1;\n');

  const report = await scanRepository(root);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('FAKE_SECRET_PATH_VALUE_998877'), false);
  assert.ok(report.files.some((file) => file.path === '[redacted]' && file.extension === '.js'));
});
