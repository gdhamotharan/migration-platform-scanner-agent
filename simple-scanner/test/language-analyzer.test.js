import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { FILE_FORMAT_EXTENSIONS, LANGUAGE_EXTENSIONS, classifyFile } from '../src/repository/file-classifier.js';
import { LanguageAnalyzer } from '../src/analyzers/language-analyzer.js';

test('extension registry detects required languages and compound TypeScript declarations', () => {
  for (const [extension, language] of Object.entries({
    '.js': 'JavaScript', '.ts': 'TypeScript', '.java': 'Java', '.cs': 'C#', '.py': 'Python',
    '.go': 'Go', '.kt': 'Kotlin', '.scala': 'Scala', '.php': 'PHP', '.rb': 'Ruby', '.c': 'C',
    '.cpp': 'C++', '.sql': 'SQL', '.html': 'HTML', '.css': 'CSS', '.sh': 'Shell',
    '.ps1': 'PowerShell'
  })) assert.equal(LANGUAGE_EXTENSIONS[extension], language);
  assert.deepEqual(FILE_FORMAT_EXTENSIONS, {
    '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.xml': 'XML', '.toml': 'TOML', '.ini': 'INI',
    '.md': 'Markdown', '.mdx': 'MDX', '.csv': 'CSV', '.tsv': 'TSV', '.png': 'PNG', '.jpg': 'JPEG',
    '.jpeg': 'JPEG', '.gif': 'GIF', '.webp': 'WebP', '.pdf': 'PDF', '.csproj': 'XML', '.fsproj': 'XML',
    '.vbproj': 'XML', '.props': 'XML', '.targets': 'XML', '.slnx': 'XML'
  });
  assert.equal(classifyFile('types/shared.d.ts').language, 'TypeScript');
});

test('language analyzer streams line and blank-line counts without retaining source content', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-stats-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  await mkdir(path.join(rootPath, 'src'));
  await writeFile(path.join(rootPath, 'src', 'types.ts'), 'a\n\n');
  await writeFile(path.join(rootPath, 'README.md'), 'hi');
  await writeFile(path.join(rootPath, 'src', 'view.test.ts'), 'test data\n');
  const files = [
    { absolutePath: path.join(rootPath, 'src', 'types.ts'), relativePath: 'src/types.ts', sizeBytes: 3, language: 'TypeScript', category: 'source_code', flags: { test: false } },
    { absolutePath: path.join(rootPath, 'README.md'), relativePath: 'README.md', sizeBytes: 2, language: 'Markdown', category: 'documentation', flags: { test: false, documentation: true } },
    { absolutePath: path.join(rootPath, 'src', 'view.test.ts'), relativePath: 'src/view.test.ts', sizeBytes: 10, language: 'TypeScript', category: 'test_code', flags: { test: true } }
  ];

  const result = await new LanguageAnalyzer().analyze({ rootPath, files, options: { includeTests: false } });
  assert.equal(result.statistics.files_processed, 1);
  assert.equal(result.statistics.total_source_size_bytes, 3);
  assert.equal(result.statistics.total_lines, 2);
  assert.equal(result.statistics.blank_lines, 1);
  assert.equal(result.statistics.comment_lines, null);
  assert.equal(result.statistics.comment_count_status, 'unavailable');
  assert.deepEqual(result.languages.map(({ name, file_count }) => [name, file_count]), [['TypeScript', 1]]);
  assert.equal(JSON.stringify(result).includes('test data'), false);
});

test('language analyzer omits NUL-containing files from text statistics', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-binary-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const absolutePath = path.join(rootPath, 'odd.txt');
  await writeFile(absolutePath, Buffer.from([65, 0, 66]));
  const result = await new LanguageAnalyzer().analyze({ rootPath, files: [
    { absolutePath, relativePath: 'odd.txt', sizeBytes: 3, language: null, category: 'source_code', flags: { test: false } }
  ], options: {} });
  assert.equal(result.statistics.files_processed, 0);
  assert.deepEqual(result.excluded_items, [{ path: 'odd.txt', reason: 'binary_content' }]);
});

test('language analyzer measures source and test code separately and ignores config and data', async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-separated-metrics-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const sourceText = 'class App {}\r\n';
  const testText = 'class AppTests {}\n\n';
  const configText = JSON.stringify({ key: 'x'.repeat(1000) });
  const files = [
    ['src/App.cs', sourceText], ['tests/AppTests.cs', testText], ['appsettings.json', configText]
  ];
  const classified = [];
  for (const [relativePath, content] of files) {
    const absolutePath = path.join(rootPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    classified.push({ absolutePath, relativePath, sizeBytes: Buffer.byteLength(content), ...classifyFile(relativePath) });
  }

  const excludedTests = await new LanguageAnalyzer().analyze({ rootPath, files: classified, options: {} });
  assert.equal(excludedTests.statistics.source_code_size_bytes, Buffer.byteLength(sourceText));
  assert.equal(excludedTests.statistics.source_code_lines, 1);
  assert.equal(excludedTests.statistics.test_code_size_bytes, 0);
  assert.equal(excludedTests.statistics.test_files_excluded, 1);
  assert.equal(excludedTests.statistics.comment_count_status, 'unavailable');
  assert.equal(excludedTests.statistics.comment_count_unavailable_files, 1);
  assert.deepEqual(excludedTests.analyzed_files, ['src/App.cs']);

  const includedTests = await new LanguageAnalyzer().analyze({ rootPath, files: classified, options: { includeTests: true } });
  assert.equal(includedTests.statistics.source_code_size_bytes, Buffer.byteLength(sourceText));
  assert.equal(includedTests.statistics.test_code_size_bytes, Buffer.byteLength(testText));
  assert.equal(includedTests.statistics.test_code_lines, 2);
  assert.deepEqual(includedTests.analyzed_files.sort(), ['src/App.cs', 'tests/AppTests.cs']);
});
