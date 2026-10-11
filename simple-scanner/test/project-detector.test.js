import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile } from '../src/repository/file-classifier.js';
import { detectProjects } from '../src/repository/project-detector.js';

test('project detector recognizes supported ecosystems and nests project relationships', () => {
  const paths = [
    'package.json', 'package-lock.json', 'app.sln', 'src/App.csproj', 'src/packages.lock.json', 'service/pom.xml',
    'python/pyproject.toml', 'gradle/build.gradle.kts', 'go/go.mod', 'php/composer.json',
    'ruby/Gemfile', 'rust/Cargo.toml'
  ];
  const projects = detectProjects(paths.map((relativePath) => ({ relativePath, ...classifyFile(relativePath) })));
  const byPath = new Map(projects.map((project) => [project.manifest_path, project]));

  assert.equal(byPath.get('package.json').project_type, 'Node.js project');
  assert.deepEqual(byPath.get('package.json').manifest_paths, ['package-lock.json', 'package.json']);
  assert.equal(byPath.get('app.sln').ecosystem, '.NET');
  assert.equal(byPath.get('src/App.csproj').parent_project_path, 'app.sln');
  assert.ok(byPath.get('src/App.csproj').manifest_paths.includes('src/packages.lock.json'));
  assert.match(byPath.get('src/App.csproj').project_id, /^project-[a-f0-9]{24}$/);
  assert.equal(detectProjects(paths.map((relativePath) => ({ relativePath, ...classifyFile(relativePath) })))
    .find((project) => project.manifest_path === 'src/App.csproj').project_id, byPath.get('src/App.csproj').project_id);
  assert.equal(byPath.get('service/pom.xml').ecosystem, 'Maven');
  assert.equal(byPath.get('python/pyproject.toml').ecosystem, 'Python');
  assert.equal(byPath.get('gradle/build.gradle.kts').ecosystem, 'Gradle');
  assert.equal(byPath.get('go/go.mod').ecosystem, 'Go');
  assert.equal(byPath.get('php/composer.json').ecosystem, 'PHP');
  assert.equal(byPath.get('ruby/Gemfile').ecosystem, 'Ruby');
  assert.equal(byPath.get('rust/Cargo.toml').ecosystem, 'Rust');
});
