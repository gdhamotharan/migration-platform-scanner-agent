import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { realpath, stat } from 'node:fs/promises';
import { walkRepository } from './repository/file-walker.js';
import { detectProjects } from './repository/project-detector.js';
import { AnalyzerRegistry } from './analyzers/analyzer-registry.js';
import { LanguageAnalyzer } from './analyzers/language-analyzer.js';
import { DependencyAnalyzer } from './analyzers/dependency-analyzer.js';
import { DotnetAnalyzer } from './analyzers/dotnet-analyzer.js';
import { TechnologyAnalyzer } from './analyzers/technology-analyzer.js';
import { buildReport } from './reporting/report-builder.js';

export class ScanStartError extends Error {
  constructor(message, code = 'SCAN_ERROR') {
    super(message);
    this.name = 'ScanStartError';
    this.code = code;
  }
}

async function validateRoot(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new ScanStartError('A repository directory is required.', 'INVALID_PATH');
  }
  const resolved = path.resolve(inputPath);
  let rootPath;
  try {
    rootPath = await realpath(resolved);
  } catch (error) {
    const code = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code) ? error.code : 'SCAN_ERROR';
    const message = error.code === 'ENOENT'
      ? 'The requested repository directory does not exist or is inaccessible.'
      : 'The requested repository directory could not be accessed.';
    throw new ScanStartError(message, code);
  }
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) throw new ScanStartError('The requested path is not a directory.', 'ENOTDIR');
  } catch (error) {
    if (error instanceof ScanStartError) throw error;
    const code = ['EACCES', 'EPERM', 'ENOENT'].includes(error.code) ? error.code : 'SCAN_ERROR';
    throw new ScanStartError('The requested repository directory could not be accessed.', code);
  }
  return rootPath;
}

function createDefaultRegistry() {
  const registry = new AnalyzerRegistry();
  registry.register(new LanguageAnalyzer());
  registry.register(new DependencyAnalyzer());
  registry.register(new DotnetAnalyzer());
  registry.register(new TechnologyAnalyzer());
  return registry;
}

export async function scanRepository(inputPath, options = {}) {
  const rootPath = await validateRoot(inputPath);
  const startedAt = new Date().toISOString();
  const startTick = performance.now();
  const normalizedOptions = {
    maxFiles: options.maxFiles ?? 100000,
    maxFileSizeBytes: options.maxFileSizeBytes ?? 5 * 1024 * 1024,
    includeTests: Boolean(options.includeTests),
    excludeDirs: options.excludeDirs ?? [],
    includeAbsolutePaths: Boolean(options.includeAbsolutePaths)
  };
  const files = [];
  const excludedItems = [];
  const errors = [];
  const warnings = [];
  const discoveredFilePaths = new Set();
  const excludedFilePaths = new Set();
  const skippedFilePaths = new Set();
  const failedFilePaths = new Set();
  const excludedDirectoryPaths = new Set();
  const failedDirectoryPaths = new Set();
  const filesByCategory = {};
  let totalDiscoveredSizeBytes = 0;
  let traversalComplete = true;
  let unvisitedFilesUnknown = false;
  let cancelled = false;
  let lastProgressCount = 0;

  const recordDiscoveredFile = (relativePath, sizeBytes, category) => {
    if (!relativePath || discoveredFilePaths.has(relativePath)) return;
    discoveredFilePaths.add(relativePath);
    if (Number.isFinite(sizeBytes)) totalDiscoveredSizeBytes += sizeBytes;
    if (category) filesByCategory[category] = (filesByCategory[category] ?? 0) + 1;
  };

  try {
    for await (const event of walkRepository(rootPath, normalizedOptions)) {
      if (options.signal?.aborted) {
        cancelled = true;
        traversalComplete = false;
        unvisitedFilesUnknown = true;
        warnings.push({ code: 'SCAN_CANCELLED' });
        break;
      }
      if (event.type === 'file') {
        files.push(event);
        recordDiscoveredFile(event.relativePath, event.sizeBytes, event.category);
      } else if (event.type === 'excluded') {
        excludedItems.push({
          relativePath: event.relativePath,
          reason: event.reason,
          itemType: event.itemType,
          sizeBytes: event.sizeBytes,
          category: event.category
        });
        if (event.itemType === 'file') {
          recordDiscoveredFile(event.relativePath, event.sizeBytes, event.category);
          if (['sensitive_file', 'generated_artifact', 'binary_file'].includes(event.reason)) {
            excludedFilePaths.add(event.relativePath);
          } else if (event.reason === 'file_too_large') {
            skippedFilePaths.add(event.relativePath);
            traversalComplete = false;
            warnings.push({ code: 'FILE_TOO_LARGE', file_path: event.relativePath });
          }
        } else if (event.itemType === 'directory') {
          excludedDirectoryPaths.add(event.relativePath);
        }
      } else if (event.type === 'limit') {
        traversalComplete = false;
        unvisitedFilesUnknown = true;
        if (event.itemType === 'file') {
          recordDiscoveredFile(event.relativePath, event.sizeBytes, event.category);
          skippedFilePaths.add(event.relativePath);
          excludedItems.push({
            relativePath: event.relativePath, reason: 'max_files', itemType: 'file',
            sizeBytes: event.sizeBytes, category: event.category
          });
        }
        warnings.push({ code: 'MAX_FILES_REACHED' });
      } else if (event.type === 'error') {
        traversalComplete = false;
        if (event.itemType === 'directory') {
          failedDirectoryPaths.add(event.relativePath);
          unvisitedFilesUnknown = true;
        } else if (event.itemType === 'file') {
          recordDiscoveredFile(event.relativePath, undefined, event.category);
          failedFilePaths.add(event.relativePath);
        }
        errors.push({
          code: event.itemType === 'directory' ? 'DIRECTORY_READ_FAILED' : 'FILE_READ_FAILED',
          file_path: event.relativePath
        });
      }
      if (discoveredFilePaths.size > 0
        && (discoveredFilePaths.size === 1 || discoveredFilePaths.size % 1000 === 0)
        && discoveredFilePaths.size !== lastProgressCount) {
        options.onProgress?.({ filesProcessed: discoveredFilePaths.size });
        lastProgressCount = discoveredFilePaths.size;
      }
    }
  } catch (error) {
    if (error instanceof ScanStartError) throw error;
    const code = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code) ? error.code : 'SCAN_ERROR';
    throw new ScanStartError('The repository scan could not be started.', code);
  }

  const registry = options.analyzerRegistry ?? createDefaultRegistry();
  const execution = await registry.run({
    rootPath,
    files,
    signal: options.signal,
    options: {
      includeTests: normalizedOptions.includeTests,
      maxFileSizeBytes: normalizedOptions.maxFileSizeBytes,
      dotnetHandled: !options.analyzerRegistry
    }
  }, options.analyzerIds);
  const analyzerResults = execution.results;
  const languageResult = analyzerResults.language;
  const dependencyResult = analyzerResults.dependencies;
  const dotnetResult = analyzerResults.dotnet;
  const projects = detectProjects(files, dotnetResult);
  cancelled ||= Boolean(options.signal?.aborted);
  const binaryPaths = new Set((languageResult?.excluded_items ?? []).map((item) => item.path));
  for (const filePath of binaryPaths) skippedFilePaths.add(filePath);
  const analyzedFilePaths = new Set();
  for (const result of Object.values(analyzerResults)) {
    for (const filePath of result?.analyzed_files ?? []) analyzedFilePaths.add(filePath);
    for (const fileError of result?.file_errors ?? []) {
      const filePath = fileError.path ?? fileError.file_path;
      if (filePath) failedFilePaths.add(filePath);
    }
  }
  for (const file of files) {
    if (!analyzedFilePaths.has(file.relativePath) && !failedFilePaths.has(file.relativePath)) {
      skippedFilePaths.add(file.relativePath);
    }
  }
  const reportFiles = files;
  const complete = traversalComplete
    && !cancelled
    && !errors.length
    && !failedFilePaths.size
    && !failedDirectoryPaths.size
    && !(execution.failures?.length)
    && !execution.executions?.some((item) => item.selected && item.status !== 'completed')
    && !dependencyResult?.incomplete
    && !dotnetResult?.incomplete
    && !Object.values(analyzerResults).some((result) => result?.file_errors?.length);
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(performance.now() - startTick));
  const fileCounts = {
    files_discovered: discoveredFilePaths.size,
    files_included: reportFiles.length,
    files_analyzed: analyzedFilePaths.size,
    files_excluded: excludedFilePaths.size,
    files_skipped: skippedFilePaths.size,
    files_failed: failedFilePaths.size,
    directories_excluded: excludedDirectoryPaths.size,
    directories_failed: failedDirectoryPaths.size,
    unvisited_files_unknown: unvisitedFilesUnknown
  };

  return buildReport({
    analysisId: randomUUID(),
    startedAt,
    completedAt,
    durationMs,
    rootPath,
    options: normalizedOptions,
    complete,
    cancelled,
    files: reportFiles,
    fileCounts,
    filesByCategory,
    totalDiscoveredSizeBytes,
    totalIncludedSizeBytes: reportFiles.reduce((total, file) => total + (Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0), 0),
    excludedItems,
    projects,
    analyzerResults,
    dotnetResult,
    analyzerFailures: execution.failures,
    analyzerExecutions: execution.executions,
    analyzerExecutionCounts: execution.counts,
    warnings,
    errors
  });
}
