import path from 'node:path';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { isPathInside } from '../utils/safe-path.js';
import { classifyFile } from './file-classifier.js';

export const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'coverage',
  '.next', '.venv', 'venv', '__pycache__'
]);

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export async function* walkRepository(inputRoot, options = {}) {
  const rootPath = await realpath(path.resolve(inputRoot));
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) {
    const error = new Error('Selected path is not a directory.');
    error.code = 'ENOTDIR';
    throw error;
  }
  const maxFiles = options.maxFiles ?? 100000;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new RangeError('maxFiles must be a positive integer.');
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 1) throw new RangeError('maxFileSizeBytes must be a positive integer.');

  const excludedDirectories = new Set([
    ...DEFAULT_EXCLUDED_DIRECTORIES,
    ...(options.excludeDirs ?? [])
  ].map((name) => String(name).toLowerCase()));
  const state = { seenFiles: 0, stopped: false };

  async function inspectDirectory(directoryPath) {
    const info = await lstat(directoryPath);
    if (info.isSymbolicLink()) return { kind: 'symlink', info };
    if (!info.isDirectory()) return { kind: 'not_directory', info };
    const canonicalPath = await realpath(directoryPath);
    if (!isPathInside(rootPath, canonicalPath)) return { kind: 'outside', info };
    return { kind: 'ok', info };
  }

  async function* visit(directoryPath, relativeDirectory) {
    let beforeRead;
    try {
      beforeRead = await inspectDirectory(directoryPath);
    } catch (error) {
      yield { type: 'error', relativePath: relativeDirectory || '.', itemType: 'directory', error };
      return;
    }
    if (beforeRead.kind !== 'ok') {
      if (beforeRead.kind === 'not_directory') {
        const error = new Error('Repository directory changed during traversal.');
        error.code = 'ESTALE';
        yield { type: 'error', relativePath: relativeDirectory || '.', itemType: 'directory', error };
      } else {
        yield {
          type: 'excluded', relativePath: relativeDirectory || '.',
          reason: beforeRead.kind === 'symlink' ? 'symlink_not_followed' : 'outside_repository',
          itemType: beforeRead.kind === 'symlink' ? 'symlink' : 'directory'
        };
      }
      return;
    }

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
        yield { type: 'error', relativePath: relativeDirectory || '.', itemType: 'directory', error };
      return;
    }
    try {
      const afterRead = await inspectDirectory(directoryPath);
      if (afterRead.kind === 'symlink' || afterRead.kind === 'outside') {
        yield {
          type: 'excluded', relativePath: relativeDirectory || '.',
          reason: afterRead.kind === 'symlink' ? 'symlink_not_followed' : 'outside_repository',
          itemType: afterRead.kind === 'symlink' ? 'symlink' : 'directory'
        };
        return;
      }
      if (afterRead.kind !== 'ok' || afterRead.info.dev !== beforeRead.info.dev || afterRead.info.ino !== beforeRead.info.ino) {
        const error = new Error('Repository directory changed during traversal.');
        error.code = 'ESTALE';
        yield { type: 'error', relativePath: relativeDirectory || '.', itemType: 'directory', error };
        return;
      }
    } catch (error) {
      yield { type: 'error', relativePath: relativeDirectory || '.', itemType: 'directory', error };
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (state.stopped) return;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directoryPath, entry.name);
      if (!isPathInside(rootPath, absolutePath)) {
        yield { type: 'excluded', relativePath: normalizeRelative(relativePath), reason: 'outside_repository', itemType: 'unknown' };
        continue;
      }
      if (entry.isSymbolicLink()) {
        yield { type: 'excluded', relativePath: normalizeRelative(relativePath), reason: 'symlink_not_followed', itemType: 'symlink' };
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name.toLowerCase())) {
          yield { type: 'excluded', relativePath: normalizeRelative(relativePath), reason: 'excluded_directory', itemType: 'directory' };
          continue;
        }
        const directoryInfo = classifyFile(relativePath);
        if (directoryInfo.sensitive) {
          yield { type: 'excluded', relativePath: normalizeRelative(relativePath), reason: 'sensitive_directory', itemType: 'directory' };
          continue;
        }
        yield* visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let fileInfo;
      try {
        fileInfo = await lstat(absolutePath);
      } catch (error) {
        if (state.seenFiles >= maxFiles) {
          state.stopped = true;
          yield { type: 'limit', reason: 'max_files', limit: maxFiles, relativePath: normalizeRelative(relativePath), itemType: 'file' };
          return;
        }
        state.seenFiles += 1;
        yield { type: 'error', relativePath: normalizeRelative(relativePath), itemType: 'file', category: classifyFile(relativePath).category, error };
        continue;
      }
      if (fileInfo.isSymbolicLink()) {
        yield { type: 'excluded', relativePath: normalizeRelative(relativePath), reason: 'symlink_not_followed', itemType: 'symlink' };
        continue;
      }
      if (!fileInfo.isFile()) continue;
      const classified = classifyFile(relativePath);
      if (state.seenFiles >= maxFiles) {
        state.stopped = true;
        yield {
          type: 'limit', reason: 'max_files', limit: maxFiles,
          relativePath: normalizeRelative(relativePath), itemType: 'file',
          sizeBytes: fileInfo.size, category: classified.category
        };
        return;
      }
      state.seenFiles += 1;
      const excluded = (reason) => ({
        type: 'excluded', relativePath: normalizeRelative(relativePath), reason, itemType: 'file',
        sizeBytes: fileInfo.size, category: classified.category, language: classified.language,
        fileFormat: classified.fileFormat, flags: classified.flags
      });
      if (classified.sensitive) {
        yield excluded('sensitive_file');
      } else if (classified.generated) {
        yield excluded('generated_artifact');
      } else if (classified.binary) {
        yield excluded('binary_file');
      } else if (fileInfo.size > maxFileSizeBytes) {
        yield excluded('file_too_large');
      } else {
        yield {
          type: 'file',
          absolutePath,
          relativePath: normalizeRelative(relativePath),
          sizeBytes: fileInfo.size,
          extension: classified.extension,
          language: classified.language,
          fileFormat: classified.fileFormat,
          category: classified.category,
          flags: classified.flags,
          manifest: classified.manifest
        };
      }
    }
  }

  yield* visit(rootPath, '');
}
