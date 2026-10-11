import { StringDecoder } from 'node:string_decoder';
import { Analyzer } from './analyzer-registry.js';
import { openFileInsideRoot } from '../utils/safe-path.js';
import { sanitizeError } from '../utils/errors.js';
import { LANGUAGE_EXTENSIONS } from '../repository/file-classifier.js';

const SOURCE_LANGUAGES = new Set(Object.values(LANGUAGE_EXTENSIONS));

async function measureTextFile(rootPath, file, maxFileSizeBytes) {
  const { handle } = await openFileInsideRoot(rootPath, file.absolutePath, { maxBytes: maxFileSizeBytes });
  const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let pendingCarriageReturn = false;
  let totalLines = 0;
  let blankLines = 0;
  let readBytes = 0;

  function countLine(line) {
    totalLines += 1;
    if (line.trim().length === 0) blankLines += 1;
  }

  function consume(text) {
    if (pendingCarriageReturn) {
      if (text.startsWith('\n')) text = text.slice(1);
      pendingCarriageReturn = false;
    }
    const combined = carry + text;
    const parts = combined.split(/\r\n|\n|\r/);
    carry = parts.pop() ?? '';
    for (const line of parts) countLine(line);
    if (combined.endsWith('\r')) pendingCarriageReturn = true;
  }

  try {
    for await (const chunk of stream) {
      readBytes += chunk.length;
      if (readBytes > maxFileSizeBytes) {
        stream.destroy();
        throw new Error('Selected file exceeds the configured size limit.');
      }
      if (chunk.includes(0)) {
        stream.destroy();
        return { binary: true };
      }
      consume(decoder.write(chunk));
    }
    consume(decoder.end());
    if (carry.length > 0) countLine(carry);
    return { binary: false, totalLines, blankLines };
  } finally {
    await handle.close();
  }
}

export class LanguageAnalyzer extends Analyzer {
  constructor() {
    super({ id: 'language', version: '1.0.0' });
  }

  async analyze(context) {
    const languageStats = new Map();
    const testLanguageStats = new Map();
    const excludedItems = [];
    const fileErrors = [];
    const analyzedFiles = [];
    let sourceFilesAnalyzed = 0;
    let testFilesAnalyzed = 0;
    let sourceSizeBytes = 0;
    let sourceLines = 0;
    let sourceBlankLines = 0;
    let testSizeBytes = 0;
    let testLines = 0;
    let testBlankLines = 0;
    let testsExcluded = 0;
    const maxFileSizeBytes = context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024;

    for (const file of context.files ?? []) {
      const category = file.category ?? (file.flags?.documentation ? 'documentation'
        : file.flags?.test ? 'test_code'
          : file.language && SOURCE_LANGUAGES.has(file.language) ? 'source_code' : 'other');
      if (!['source_code', 'test_code'].includes(category)) continue;
      if (category === 'test_code' && !context.options?.includeTests) {
        testsExcluded += 1;
        continue;
      }
      try {
        const counts = await measureTextFile(context.rootPath, file, maxFileSizeBytes);
        if (counts.binary) {
          excludedItems.push({ path: file.relativePath, reason: 'binary_content' });
          continue;
        }
        analyzedFiles.push(file.relativePath);
        const testCode = category === 'test_code';
        if (testCode) {
          testFilesAnalyzed += 1;
          testSizeBytes += file.sizeBytes;
          testLines += counts.totalLines;
          testBlankLines += counts.blankLines;
        } else {
          sourceFilesAnalyzed += 1;
          sourceSizeBytes += file.sizeBytes;
          sourceLines += counts.totalLines;
          sourceBlankLines += counts.blankLines;
        }
        const languageMap = testCode ? testLanguageStats : languageStats;
        if (file.language) {
          const stats = languageMap.get(file.language) ?? { name: file.language, file_count: 0, size_bytes: 0, lines: 0, blank_lines: 0 };
          stats.file_count += 1;
          stats.size_bytes += file.sizeBytes;
          stats.lines += counts.totalLines;
          stats.blank_lines += counts.blankLines;
          languageMap.set(file.language, stats);
        }
      } catch (error) {
        fileErrors.push({ path: file.relativePath, ...sanitizeError(error, file.relativePath) });
      }
    }

    return {
      languages: [...languageStats.values()].sort((left, right) => left.name.localeCompare(right.name)),
      test_languages: [...testLanguageStats.values()].sort((left, right) => left.name.localeCompare(right.name)),
      analyzed_files: analyzedFiles.sort((left, right) => left.localeCompare(right)),
      statistics: {
        files_processed: sourceFilesAnalyzed + testFilesAnalyzed,
        source_code_files_analyzed: sourceFilesAnalyzed,
        test_code_files_analyzed: testFilesAnalyzed,
        test_files_excluded: testsExcluded,
        total_source_size_bytes: sourceSizeBytes,
        source_code_size_bytes: sourceSizeBytes,
        source_code_lines: sourceLines,
        source_code_blank_lines: sourceBlankLines,
        test_code_size_bytes: testSizeBytes,
        test_code_lines: testLines,
        test_code_blank_lines: testBlankLines,
        total_lines: sourceLines + testLines,
        blank_lines: sourceBlankLines + testBlankLines,
        comment_lines: null,
        comment_count_status: 'unavailable',
        comment_count_unavailable_files: sourceFilesAnalyzed + testFilesAnalyzed
      },
      excluded_items: excludedItems,
      file_errors: fileErrors
    };
  }
}
