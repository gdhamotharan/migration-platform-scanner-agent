import path from 'node:path';

export const LANGUAGE_EXTENSIONS = Object.freeze({
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript', '.tsx': 'TypeScript', '.d.ts': 'TypeScript',
  '.java': 'Java', '.cs': 'C#', '.py': 'Python', '.go': 'Go', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.scala': 'Scala', '.php': 'PHP', '.rb': 'Ruby', '.c': 'C', '.h': 'C', '.cc': 'C++',
  '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hxx': 'C++', '.sql': 'SQL',
  '.html': 'HTML', '.htm': 'HTML', '.css': 'CSS', '.sh': 'Shell', '.bash': 'Shell',
  '.zsh': 'Shell', '.ps1': 'PowerShell', '.psm1': 'PowerShell'
});

export const FILE_FORMAT_EXTENSIONS = Object.freeze({
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.xml': 'XML', '.toml': 'TOML',
  '.ini': 'INI', '.md': 'Markdown', '.mdx': 'MDX', '.csv': 'CSV', '.tsv': 'TSV',
  '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.gif': 'GIF', '.webp': 'WebP', '.pdf': 'PDF',
  '.csproj': 'XML', '.fsproj': 'XML', '.vbproj': 'XML', '.props': 'XML', '.targets': 'XML', '.slnx': 'XML'
});

export const PROJECT_FILE_RULES = Object.freeze({
  'package.json': { ecosystem: 'Node.js', type: 'Node.js project', role: 'primary', dependency: true, project: true },
  'package-lock.json': { ecosystem: 'Node.js', type: 'Node.js lockfile', role: 'lockfile', dependency: true, project: true },
  'npm-shrinkwrap.json': { ecosystem: 'Node.js', type: 'Node.js lockfile', role: 'lockfile', dependency: true, project: true },
  'pnpm-lock.yaml': { ecosystem: 'Node.js', type: 'Node.js lockfile', role: 'lockfile', dependency: true, project: true },
  'yarn.lock': { ecosystem: 'Node.js', type: 'Node.js lockfile', role: 'lockfile', dependency: true, project: true },
  'tsconfig.json': { ecosystem: 'Node.js', type: 'TypeScript configuration', role: 'configuration', project: false, build: true },
  '.sln': { ecosystem: '.NET', type: '.NET solution', role: 'primary', project: true, build: true },
  '.slnx': { ecosystem: '.NET', type: '.NET solution', role: 'primary', project: true, build: true },
  '.csproj': { ecosystem: '.NET', type: 'C# project', role: 'primary', project: true, dependency: true, build: true },
  '.fsproj': { ecosystem: '.NET', type: 'F# project', role: 'primary', project: true, dependency: true, build: true },
  '.vbproj': { ecosystem: '.NET', type: 'Visual Basic project', role: 'primary', project: true, dependency: true, build: true },
  'global.json': { ecosystem: '.NET', type: '.NET SDK configuration', role: 'configuration', project: false, build: true },
  'directory.build.props': { ecosystem: '.NET', type: '.NET build configuration', role: 'configuration', project: false, build: true },
  'directory.build.targets': { ecosystem: '.NET', type: '.NET build configuration', role: 'configuration', project: false, build: true },
  'directory.packages.props': { ecosystem: '.NET', type: '.NET package configuration', role: 'configuration', project: false, dependency: true, build: true },
  'packages.lock.json': { ecosystem: '.NET', type: '.NET lockfile', role: 'lockfile', project: false, dependency: true, build: true },
  'pom.xml': { ecosystem: 'Maven', type: 'Maven project', role: 'primary', project: true, dependency: true, build: true },
  'build.gradle': { ecosystem: 'Gradle', type: 'Gradle project', role: 'primary', project: true, dependency: true, build: true },
  'build.gradle.kts': { ecosystem: 'Gradle', type: 'Gradle project', role: 'primary', project: true, dependency: true, build: true },
  'settings.gradle': { ecosystem: 'Gradle', type: 'Gradle settings', role: 'primary', project: true, build: true },
  'settings.gradle.kts': { ecosystem: 'Gradle', type: 'Gradle settings', role: 'primary', project: true, build: true },
  'gradlew': { ecosystem: 'Gradle', type: 'Gradle wrapper', role: 'tooling', project: false, build: true },
  'gradlew.bat': { ecosystem: 'Gradle', type: 'Gradle wrapper', role: 'tooling', project: false, build: true },
  'pyproject.toml': { ecosystem: 'Python', type: 'Python project', role: 'primary', project: true, dependency: true },
  'requirements.txt': { ecosystem: 'Python', type: 'Python requirements', role: 'primary', project: true, dependency: true },
  'pipfile': { ecosystem: 'Python', type: 'Pipenv project', role: 'primary', project: true, dependency: true },
  'poetry.lock': { ecosystem: 'Python', type: 'Poetry lockfile', role: 'lockfile', project: true, dependency: true },
  'uv.lock': { ecosystem: 'Python', type: 'uv lockfile', role: 'lockfile', project: true, dependency: true },
  'go.mod': { ecosystem: 'Go', type: 'Go module', role: 'primary', project: true, dependency: true },
  'go.sum': { ecosystem: 'Go', type: 'Go checksum file', role: 'lockfile', project: true, dependency: true },
  'composer.json': { ecosystem: 'PHP', type: 'Composer project', role: 'primary', project: true, dependency: true },
  'composer.lock': { ecosystem: 'PHP', type: 'Composer lockfile', role: 'lockfile', project: true, dependency: true },
  'gemfile': { ecosystem: 'Ruby', type: 'Bundler project', role: 'primary', project: true, dependency: true },
  'gemfile.lock': { ecosystem: 'Ruby', type: 'Bundler lockfile', role: 'lockfile', project: true, dependency: true },
  'cargo.toml': { ecosystem: 'Rust', type: 'Cargo project', role: 'primary', project: true, dependency: true },
  'cargo.lock': { ecosystem: 'Rust', type: 'Cargo lockfile', role: 'lockfile', project: true, dependency: true }
});

const EXCLUDED_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.class', '.jar', '.war', '.ear',
  '.dll', '.exe', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.pyc', '.pyo', '.zip', '.7z',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.sqlite', '.db'
]);

const GENERATED_PATTERNS = [
  /\.min\.(?:js|css)$/i, /\.map$/i, /\.(?:generated|designer|g)\.(?:cs|vb|fs)$/i,
  /\.generated\.(?:ts|js)$/i, /\.(?:class|dll|exe|pyc|pyo|o|obj|so|dylib|a|lib|jar|war|ear)$/i
];

const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'secrets.json',
  'id_rsa', 'id_ed25519', 'authorized_keys', 'known_hosts', 'kubeconfig'
]);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.kube']);

function extensionFor(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return '.d.ts';
  return path.extname(lower);
}

function manifestRule(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  if (basename.endsWith('.slnx')) return PROJECT_FILE_RULES['.slnx'];
  if (basename.endsWith('.sln')) return PROJECT_FILE_RULES['.sln'];
  if (basename.endsWith('.csproj')) return PROJECT_FILE_RULES['.csproj'];
  if (basename.endsWith('.fsproj')) return PROJECT_FILE_RULES['.fsproj'];
  if (basename.endsWith('.vbproj')) return PROJECT_FILE_RULES['.vbproj'];
  const explicit = PROJECT_FILE_RULES[basename];
  if (explicit) return explicit;
  return undefined;
}

export function isSensitivePath(relativePath) {
  const parts = relativePath.split(/[\\/]+/).map((part) => part.toLowerCase());
  const basename = parts.at(-1) ?? '';
  return parts.some((part) => SENSITIVE_DIRECTORIES.has(part))
    || basename.startsWith('.env')
    || SENSITIVE_FILE_NAMES.has(basename)
    || /\.(?:pem|key|p12|pfx|crt|cer|keystore|jks)$/i.test(basename);
}

export function classifyFile(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  const extension = extensionFor(basename);
  const rule = manifestRule(relativePath);
  const language = LANGUAGE_EXTENSIONS[extension] ?? null;
  const fileFormat = FILE_FORMAT_EXTENSIONS[extension] ?? null;
  const isTest = /(^|[\\/])(?:test|tests|spec|specs|__tests__)([\\/]|$)/i.test(relativePath)
    || /(?:\.test|\.spec)\.[^.]+$/i.test(basename);
  const isDocumentation = ['.md', '.mdx'].includes(extension) || /^readme(?:\.|$)/i.test(basename);
  const isSeedOrDataPath = /(^|[\\/])(?:data|seed|seeds|fixtures)([\\/]|$)/i.test(relativePath);
  const isSettingsJson = extension === '.json'
    && /^(?:appsettings(?:\.[^.]+)?|launchsettings|settings|config|tsconfig)(?:\.json)?$/i.test(basename);
  const isConfiguration = Boolean(['.yaml', '.yml', '.xml', '.toml', '.ini', '.conf', '.config'].includes(extension)
    || isSettingsJson) && !rule?.project;
  const generated = GENERATED_PATTERNS.some((pattern) => pattern.test(basename));
  const binary = EXCLUDED_BINARY_EXTENSIONS.has(extension);
  const flags = {
    project: Boolean(rule?.project),
    build: Boolean(rule?.build),
    dependency: Boolean(rule?.dependency),
    test: isTest,
    configuration: isConfiguration || rule?.role === 'configuration',
    documentation: isDocumentation
  };
  const category = generated ? 'generated'
    : binary ? 'static_asset'
      : rule && ['.csproj', '.fsproj', '.vbproj'].includes(extension) ? 'project_manifest'
        : rule?.dependency ? 'dependency_manifest'
        : rule?.role === 'primary' || rule?.project ? 'project_manifest'
          : flags.build ? 'build_configuration'
            : flags.documentation ? 'documentation'
              : language && isTest ? 'test_code'
                : language ? 'source_code'
                  : isConfiguration ? 'configuration'
                    : fileFormat && !isSeedOrDataPath ? (['YAML', 'XML', 'TOML', 'INI'].includes(fileFormat) ? 'configuration' : 'data')
                      : fileFormat ? 'data' : 'other';
  return {
    relativePath: relativePath.split(/[\\/]+/).join('/'),
    extension,
    language,
    fileFormat,
    category,
    flags,
    manifest: rule ? { ...rule } : null,
    generated,
    binary,
    sensitive: isSensitivePath(relativePath)
  };
}
