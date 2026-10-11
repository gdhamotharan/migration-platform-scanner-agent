import { createHash } from 'node:crypto';

export function stableProjectId(relativePath, ecosystem = 'unknown') {
  const identity = `${String(ecosystem).toLowerCase()}\0${String(relativePath).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()}`;
  return `project-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}
