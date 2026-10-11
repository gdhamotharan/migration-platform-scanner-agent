const SAFE_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOSPC',
  'EISDIR', 'ENOTDIR', 'EIO', 'PARSE_ERROR', 'SCAN_ERROR'
]);

export function sanitizeError(error, reportPath = 'repository') {
  const candidate = typeof error?.code === 'string' ? error.code : 'SCAN_ERROR';
  const code = SAFE_CODES.has(candidate) ? candidate : 'SCAN_ERROR';
  const safePath = String(reportPath).replaceAll('\\', '/').replace(/^\/+/, '');
  return { code, message: `Unable to process ${safePath || 'repository'}.` };
}

export function makeWarning(code, message, filePath = undefined) {
  return {
    code,
    ...(filePath ? { file_path: filePath } : {}),
    message
  };
}
