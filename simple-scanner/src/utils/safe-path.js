import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

export function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function toReportPath(rootPath, candidatePath, includeAbsolutePaths = false) {
  const absolutePath = path.resolve(candidatePath);
  if (!isPathInside(rootPath, absolutePath)) {
    throw new Error('Path is outside the selected repository root.');
  }
  if (includeAbsolutePaths) return absolutePath;
  return path.relative(path.resolve(rootPath), absolutePath).split(path.sep).join('/');
}

export async function openFileInsideRoot(rootPath, candidatePath, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const inputRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(candidatePath);
  if (!isPathInside(inputRoot, absolutePath)) throw new Error('Path is outside the selected repository root.');
  const canonicalRoot = await realpath(inputRoot);
  const [canonicalFile, pathInfo] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
  if (!isPathInside(canonicalRoot, canonicalFile)) throw new Error('Path resolves outside the selected repository root.');
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error('Selected path is not a regular file.');

  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(absolutePath, flags);
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) throw new Error('Selected path is not a regular file.');
    if (fileInfo.size > maxBytes) throw new Error('Selected file exceeds the configured size limit.');
    const [canonicalAfterOpen, pathAfterOpen] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
    const rootAfterOpen = await realpath(inputRoot);
    if (!isPathInside(rootAfterOpen, canonicalAfterOpen) || pathAfterOpen.isSymbolicLink()
      || pathAfterOpen.dev !== fileInfo.dev || pathAfterOpen.ino !== fileInfo.ino) {
      throw new Error('Selected file changed during validation.');
    }
    return { handle, sizeBytes: fileInfo.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

export async function readFileInsideRoot(rootPath, candidatePath, options = {}) {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const { handle } = await openFileInsideRoot(rootPath, candidatePath, { ...options, maxBytes });
  try {
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        stream.destroy();
        throw new Error('Selected file exceeds the configured size limit.');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}
