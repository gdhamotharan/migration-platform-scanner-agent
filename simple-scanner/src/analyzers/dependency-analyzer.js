import TOML from '@iarna/toml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Analyzer } from './analyzer-registry.js';
import { readFileInsideRoot } from '../utils/safe-path.js';

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
  trimValues: true
});

const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+:-]{0,199}$/;
const SAFE_VERSION = /^[A-Za-z0-9.*+!<>=~^|,_:/ -]{1,128}$/;
const SENSITIVE_VALUE = /(?:api[_-]?(?:key|token)|token|secret|password|credential|private[_ -]?key)\s*[:=]/i;
const TOKEN_SHAPE = /\b(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{40,}\b/;

function safeName(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return SAFE_NAME.test(candidate) && !SENSITIVE_VALUE.test(candidate) && !TOKEN_SHAPE.test(candidate) ? candidate : null;
}

function safeVersion(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 128 || !SAFE_VERSION.test(candidate)
    || candidate.includes('://') || SENSITIVE_VALUE.test(candidate) || TOKEN_SHAPE.test(candidate)) return null;
  return candidate;
}

function dependencyRecord({ name, version, ecosystem, manifestPath, classification = 'direct', development = false, optional = false, parsed = true }) {
  const safeDependencyName = safeName(name);
  const safeDeclaredVersion = safeVersion(version);
  const versionIsSafe = version === undefined || version === null || safeDeclaredVersion !== null;
  const isParsed = parsed && safeDependencyName !== null && versionIsSafe;
  return {
    name: safeDependencyName,
    version: isParsed ? safeDeclaredVersion : null,
    declared_version: isParsed ? safeDeclaredVersion : null,
    resolved_version: null,
    version_source: safeDeclaredVersion ? 'manifest' : 'missing',
    version_status: !isParsed || (safeDeclaredVersion && /^\$\{.+\}$/.test(safeDeclaredVersion))
      ? 'unresolved' : safeDeclaredVersion ? 'declared' : 'missing',
    ecosystem,
    manifest_path: manifestPath,
    classification,
    direct: true,
    development,
    optional,
    version_unresolved: !isParsed || safeDeclaredVersion === null || /^\$\{.+\}$/.test(safeDeclaredVersion),
    parse_status: isParsed ? 'parsed' : 'unparsed'
  };
}

function unparsedRecord(ecosystem, manifestPath, classification = 'direct', development = false, optional = false) {
  return dependencyRecord({
    name: null, version: null, ecosystem, manifestPath, classification, development, optional, parsed: false
  });
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function recordJsonDependencies(parsed, manifestPath) {
  const result = [];
  const sections = [
    ['dependencies', 'direct', false, false],
    ['devDependencies', 'development', true, false],
    ['optionalDependencies', 'optional', false, true]
  ];
  for (const [section, classification, development, optional] of sections) {
    const dependencies = parsed?.[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      result.push(unparsedRecord('Node.js', manifestPath, classification, development, optional));
      continue;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      result.push(dependencyRecord({ name, version, ecosystem: 'Node.js', manifestPath, classification, development, optional }));
    }
  }
  return result;
}

function parseRequirementLine(line) {
  let candidate = line.trim();
  if (!candidate || candidate.startsWith('#')) return { ignored: true };
  if (candidate.startsWith('-')) return { unparsed: true };
  candidate = candidate.replace(/\s+#.*$/, '').trim();
  const match = candidate.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?(\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*))?(?:\s*;\s*.+)?$/);
  if (!match) return { unparsed: true };
  return { name: match[1], version: match[2]?.trim() || null };
}

function parseRequirements(content, manifestPath) {
  const result = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseRequirementLine(line);
    if (parsed.ignored) continue;
    if (parsed.unparsed) result.push(unparsedRecord('Python', manifestPath));
    else result.push(dependencyRecord({ ...parsed, ecosystem: 'Python', manifestPath }));
  }
  return result;
}

function parsePep508(value) {
  if (typeof value !== 'string') return null;
  const parsed = parseRequirementLine(value);
  return parsed.ignored || parsed.unparsed ? null : parsed;
}

function parsePyproject(parsed, manifestPath) {
  const result = [];
  const project = parsed?.project;
  for (const requirement of asArray(project?.dependencies)) {
    const declaration = parsePep508(requirement);
    result.push(declaration
      ? dependencyRecord({ ...declaration, ecosystem: 'Python', manifestPath })
      : unparsedRecord('Python', manifestPath));
  }
  for (const [group, requirements] of Object.entries(project?.['optional-dependencies'] ?? {})) {
    const development = /(?:dev|test)/i.test(group);
    for (const requirement of asArray(requirements)) {
      const declaration = parsePep508(requirement);
      result.push(declaration
        ? dependencyRecord({ ...declaration, ecosystem: 'Python', manifestPath, classification: development ? 'development' : 'optional', development, optional: !development })
        : unparsedRecord('Python', manifestPath, development ? 'development' : 'optional', development, !development));
    }
  }

  const poetry = parsed?.tool?.poetry;
  if (poetry) {
    const addPoetrySection = (dependencies, classification, development, optional = false) => {
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
      for (const [name, declaration] of Object.entries(dependencies)) {
        if (name.toLowerCase() === 'python') continue;
        const version = typeof declaration === 'string' ? declaration : declaration?.version;
        result.push(dependencyRecord({ name, version, ecosystem: 'Python', manifestPath, classification, development, optional }));
      }
    };
    addPoetrySection(poetry.dependencies, 'direct', false);
    addPoetrySection(poetry['dev-dependencies'], 'development', true);
    for (const [group, settings] of Object.entries(poetry.group ?? {})) {
      const development = /(?:dev|test)/i.test(group);
      addPoetrySection(settings?.dependencies, development ? 'development' : 'optional', development, !development);
    }
  }
  return result;
}

function parseXmlSafely(content) {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('XML declarations are not supported.');
  const validation = XMLValidator.validate(content);
  if (validation !== true) throw new Error('Malformed XML manifest.');
  return XML_PARSER.parse(content);
}

function childText(node, key) {
  const value = node?.[key];
  if (Array.isArray(value)) return childText(value[0], '#text');
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return value['#text'].trim();
  return undefined;
}

function collectNodes(value, targetKey, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, targetKey, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === targetKey) output.push(...asArray(child));
    else collectNodes(child, targetKey, output);
  }
  return output;
}

function parseDotnetXml(parsed, manifestPath) {
  return collectNodes(parsed, 'PackageReference').map((node) => dependencyRecord({
    name: node?.['@_Include'] ?? node?.['@_Update'],
    version: node?.['@_Version'] ?? childText(node, 'Version'),
    ecosystem: '.NET',
    manifestPath
  }));
}

function parseFrameworkReferences(parsed) {
  return collectNodes(parsed, 'FrameworkReference')
    .map((node) => safeName(node?.['@_Include'] ?? node?.['@_Update']))
    .filter(Boolean);
}

function parseMavenXml(parsed, manifestPath) {
  const project = parsed?.project ?? {};
  return asArray(project.dependencies?.dependency).map((node) => {
    const group = childText(node, 'groupId');
    const artifact = childText(node, 'artifactId');
    const scope = childText(node, 'scope');
    const development = scope === 'test';
    return dependencyRecord({
      name: group && artifact ? `${group}:${artifact}` : null,
      version: childText(node, 'version'),
      ecosystem: 'Maven',
      manifestPath,
      classification: development ? 'development' : 'direct',
      development
    });
  });
}

function manifestKind(file) {
  const basename = file.relativePath.split('/').at(-1).toLowerCase();
  if (basename === 'package.json') return 'node';
  if (basename === 'requirements.txt') return 'requirements';
  if (basename === 'pyproject.toml') return 'pyproject';
  if (['.csproj', '.fsproj', '.vbproj'].some((extension) => basename.endsWith(extension))) return 'dotnet';
  if (basename === 'pom.xml') return 'maven';
  if (['build.gradle', 'build.gradle.kts'].includes(basename)) return 'gradle';
  return null;
}

export class DependencyAnalyzer extends Analyzer {
  constructor() {
    super({ id: 'dependencies', version: '1.0.0' });
  }

  async analyze(context) {
    const dependencies = [];
    const warnings = [];
    const manifestFacts = [];
    const fileErrors = [];
    const analyzedFiles = [];
    let incomplete = false;
    const maxFileSizeBytes = context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024;

    for (const file of context.files ?? []) {
      const kind = manifestKind(file);
      if (!kind) continue;
      if (kind === 'dotnet' && context.options?.dotnetHandled) continue;
      const manifestPath = file.relativePath;
      if (kind === 'gradle') {
        warnings.push({ code: 'GRADLE_RESOLUTION_UNSUPPORTED', file_path: manifestPath, message: 'Gradle dependency resolution is not implemented in V1.' });
        manifestFacts.push({ manifest_path: manifestPath, ecosystem: 'Gradle', dependencies: [], parse_status: 'unsupported' });
        continue;
      }
      try {
        const contents = await readFileInsideRoot(context.rootPath, file.absolutePath, { maxBytes: maxFileSizeBytes });
        let found;
        let frameworkReferences = [];
        if (kind === 'node') found = recordJsonDependencies(JSON.parse(contents), manifestPath);
        else if (kind === 'requirements') found = parseRequirements(contents, manifestPath);
        else if (kind === 'pyproject') found = parsePyproject(TOML.parse(contents), manifestPath);
        else {
          const parsedXml = parseXmlSafely(contents);
          found = kind === 'dotnet' ? parseDotnetXml(parsedXml, manifestPath) : parseMavenXml(parsedXml, manifestPath);
          if (kind === 'dotnet') frameworkReferences = parseFrameworkReferences(parsedXml);
        }
        dependencies.push(...found);
        analyzedFiles.push(manifestPath);
        if (found.some((dependency) => dependency.parse_status === 'unparsed')) incomplete = true;
        manifestFacts.push({
          manifest_path: manifestPath,
          ecosystem: file.manifest?.ecosystem ?? (kind === 'maven' ? 'Maven' : kind === 'dotnet' ? '.NET' : 'Python'),
          dependencies: found.filter((dependency) => dependency.parse_status === 'parsed').map(({ name, version }) => ({ name, version })),
          framework_references: frameworkReferences,
          parse_status: 'parsed'
        });
      } catch {
        incomplete = true;
        warnings.push({ code: 'MANIFEST_PARSE_FAILED', file_path: manifestPath, message: `Unable to parse ${manifestPath}.` });
        fileErrors.push({ path: manifestPath, code: 'MANIFEST_PARSE_FAILED', message: `Unable to parse ${manifestPath}.` });
        manifestFacts.push({ manifest_path: manifestPath, ecosystem: file.manifest?.ecosystem ?? 'unknown', dependencies: [], parse_status: 'failed' });
      }
    }

    dependencies.sort((left, right) => left.manifest_path.localeCompare(right.manifest_path)
      || String(left.name).localeCompare(String(right.name))
      || left.classification.localeCompare(right.classification));
    return { dependencies, manifest_facts: manifestFacts, analyzed_files: analyzedFiles.sort(), warnings, file_errors: fileErrors, incomplete };
  }
}
