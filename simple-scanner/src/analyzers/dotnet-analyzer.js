import path from 'node:path';
import { Analyzer } from './analyzer-registry.js';
import { stableProjectId } from '../repository/project-id.js';
import { parseSafeXml, xmlItemsWithConditions, xmlText } from '../utils/safe-xml.js';
import { readFileInsideRoot } from '../utils/safe-path.js';

const PROJECT_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj']);
const BUILD_FILES = new Set(['directory.build.props', 'directory.build.targets', 'directory.packages.props']);
const SAFE_VERSION = /^[A-Za-z0-9.*+!<>=~^|,_:/$(){}\[\] -]{1,128}$/;
const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+:-]{0,199}$/;
const SENSITIVE = /(?:api[_-]?(?:key|token)|token|secret|password|credential|private[_ -]?key)\s*[:=]|\b(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{40,}\b/i;

function safeText(value, max = 512) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().slice(0, max);
  if (!candidate || SENSITIVE.test(candidate)) return null;
  return candidate;
}

function safeName(value) {
  const name = safeText(value, 200);
  return name && SAFE_NAME.test(name) ? name : null;
}

function safeVersion(value) {
  const version = safeText(value, 128);
  return version && SAFE_VERSION.test(version) && !version.includes('://') ? version : null;
}

function posixDirectory(relativePath) {
  const directory = path.posix.dirname(relativePath.replaceAll('\\', '/'));
  return directory === '.' ? '' : directory;
}

function normalizeContainedPath(baseDirectory, inputPath) {
  const normalized = path.posix.normalize(path.posix.join(baseDirectory, inputPath.replaceAll('\\', '/')));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized.replace(/^\.\//, '');
}

function combineConditions(conditions) {
  const safeConditions = conditions.map((value) => safeText(value)).filter(Boolean);
  return safeConditions.length ? safeConditions.join(' AND ').slice(0, 512) : null;
}

function propertyDeclarations(parsed, names, evidencePath, method, outerCondition = null) {
  const declarations = [];
  for (const name of names) {
    for (const { node, conditions } of xmlItemsWithConditions(parsed, name)) {
      const value = safeText(typeof node === 'string' ? node : node?.['#text']);
      if (!value) continue;
      const nestedCondition = node && typeof node === 'object' ? node['@_Condition'] : undefined;
      const allConditions = nestedCondition ? [...conditions, nestedCondition] : conditions;
      declarations.push({
        property_name: name,
        declared_value: value,
        condition: combineConditions([...(outerCondition ? [outerCondition] : []), ...allConditions]),
        evidence_file_path: evidencePath,
        detection_method: method,
        status: value.includes('$(') || allConditions.length || outerCondition ? 'unresolved' : 'declared'
      });
    }
  }
  return declarations;
}

function itemDeclarations(parsed, itemName, evidencePath, outerCondition = null) {
  return xmlItemsWithConditions(parsed, itemName).map(({ node, conditions }) => {
    const itemGroupCondition = conditions.find((condition) => condition !== node?.['@_Condition']);
    const allConditions = [...(itemGroupCondition ? [itemGroupCondition] : []), ...(node?.['@_Condition'] ? [node['@_Condition']] : [])];
    return {
      name: safeText(node?.['@_Include'] ?? node?.['@_Update'], 240),
      version: safeVersion(node?.['@_Version'] ?? node?.['@_VersionOverride'] ?? xmlText(node, 'Version') ?? xmlText(node, 'VersionOverride')),
      condition: combineConditions([...(outerCondition ? [outerCondition] : []), ...allConditions]),
      evidence_file_path: evidencePath
    };
  }).filter((item) => item.name && (itemName === 'ProjectReference' || safeName(item.name)));
}

function ancestors(relativePath) {
  const result = [];
  let current = posixDirectory(relativePath);
  while (true) {
    result.push(current);
    if (!current) return result;
    current = posixDirectory(current);
  }
}

function readFileMap(files) {
  return new Map(files.map((file) => [file.relativePath.replaceAll('\\', '/'), file]));
}

function projectKind(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return PROJECT_EXTENSIONS.has(extension) ? extension : null;
}

function sdkRecord(relativePath, parsed) {
  const sdk = parsed?.sdk;
  if (!sdk || typeof sdk !== 'object' || Array.isArray(sdk)) return null;
  const version = safeVersion(sdk.version);
  if (!version) return null;
  return {
    declared_version: version,
    roll_forward: safeText(sdk.rollForward, 80),
    allow_prerelease: typeof sdk.allowPrerelease === 'boolean' ? sdk.allowPrerelease : null,
    evidence_file_path: relativePath,
    property_name: 'sdk.version',
    detection_method: 'global_json',
    status: version.includes('$(') ? 'unresolved' : 'declared'
  };
}

function lockfileVersions(parsed) {
  const versions = new Map();
  for (const framework of Object.values(parsed?.dependencies ?? {})) {
    if (!framework || typeof framework !== 'object' || Array.isArray(framework)) continue;
    for (const [rawName, entry] of Object.entries(framework)) {
      const name = safeName(rawName);
      const resolved = safeVersion(entry?.resolved);
      const requested = safeVersion(entry?.requested);
      if (!name || entry?.type !== 'Direct' || !resolved || !requested) continue;
      const current = versions.get(name) ?? [];
      if (!current.some((item) => item.requested === requested && item.resolved === resolved)) current.push({ requested, resolved });
      versions.set(name, current);
    }
  }
  return versions;
}

function lockRequestMatches(declared, requested) {
  if (declared === requested) return true;
  const exact = requested.match(/^\[([^,\]]+)\]$/);
  if (exact) return exact[1].trim() === declared;
  const lowerBound = requested.match(/^\[([^,\]]+)\s*,/);
  return Boolean(lowerBound && lowerBound[1].trim() === declared);
}

function parseSolution(relativePath, contents, isXml) {
  const entries = [];
  if (isXml) {
    const parsed = parseSafeXml(contents);
    for (const { node, conditions } of xmlItemsWithConditions(parsed, 'Project')) {
      const rawPath = node?.['@_Path'] ?? node?.['@_Include'] ?? xmlText(node, 'Path');
      if (!rawPath) continue;
      const projectPath = normalizeContainedPath(posixDirectory(relativePath), rawPath);
      if (projectPath) entries.push({ project_path: projectPath, condition: combineConditions(conditions), solution_guid: null });
    }
  } else {
    const pattern = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.\w+proj)"\s*,\s*"\{([^}]+)\}"/gim;
    for (const match of contents.matchAll(pattern)) {
      const projectPath = normalizeContainedPath(posixDirectory(relativePath), match[1]);
      if (projectPath) entries.push({ project_path: projectPath, condition: null, solution_guid: safeText(match[2], 64) });
    }
  }
  return entries;
}

export class DotnetAnalyzer extends Analyzer {
  constructor() {
    super({ id: 'dotnet', version: '1.0.0' });
  }

  async analyze(context) {
    const files = (context.files ?? []).filter((file) => file.category !== 'generated');
    const fileMap = readFileMap(files);
    const fileMapLower = new Map(files.map((file) => [file.relativePath.replaceAll('\\', '/').toLowerCase(), file]));
    const getFile = (relativePath) => fileMap.get(relativePath) ?? fileMapLower.get(relativePath.toLowerCase());
    const parsedXml = new Map();
    const fileErrors = [];
    const warnings = [];
    const unsupportedImports = [];
    const unsupportedImportKeys = new Set();
    const analyzedFiles = new Set();
    let incomplete = false;
    const canonicalPath = (relativePath) => getFile(relativePath)?.relativePath ?? relativePath;
    const recordUnsupportedImport = (sourcePath, expression, condition, reason) => {
      const key = [sourcePath, expression ?? '', condition ?? '', reason].join('\0');
      if (unsupportedImportKeys.has(key)) return;
      unsupportedImportKeys.add(key);
      unsupportedImports.push({ source_file_path: sourcePath, project_expression: expression, condition, reason });
      incomplete = true;
      warnings.push({ code: 'DOTNET_IMPORT_UNRESOLVED', file_path: sourcePath });
    };

    const parseXmlFile = async (relativePath) => {
      if (parsedXml.has(relativePath)) return parsedXml.get(relativePath);
      const file = getFile(relativePath);
      if (!file) return null;
      try {
        const contents = await readFileInsideRoot(context.rootPath, file.absolutePath, {
          maxBytes: context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024
        });
        const parsed = parseSafeXml(contents);
        parsedXml.set(relativePath, parsed);
        analyzedFiles.add(relativePath);
        return parsed;
      } catch {
        incomplete = true;
        fileErrors.push({ path: relativePath, code: 'MANIFEST_PARSE_FAILED', message: 'A .NET project or build manifest could not be parsed.' });
        parsedXml.set(relativePath, null);
        return null;
      }
    };

    const collectLocalImports = async (sourcePath, parsed, visited = new Set(), outerConditions = []) => {
      const output = [];
      for (const { node, conditions } of xmlItemsWithConditions(parsed, 'Import')) {
        const rawImportPath = safeText(node?.['@_Project'], 512);
        const condition = combineConditions([...outerConditions, ...conditions, ...(node?.['@_Condition'] ? [node['@_Condition']] : [])]);
        let unresolvedReason = !rawImportPath ? 'unsafe_or_missing_expression' : null;
        if (rawImportPath && /[$*?{}]/.test(rawImportPath)) unresolvedReason = 'dynamic_import_path';
        if (rawImportPath && (path.posix.isAbsolute(rawImportPath) || /^[A-Za-z]:[\\/]/.test(rawImportPath))) unresolvedReason = 'external_import_path';
        const importPath = !unresolvedReason ? normalizeContainedPath(posixDirectory(sourcePath), rawImportPath) : null;
        if (!unresolvedReason && !importPath) unresolvedReason = 'external_import_path';
        if (!unresolvedReason && !/\.(?:props|targets)$/i.test(importPath)) unresolvedReason = 'unsupported_import_type';
        if (unresolvedReason) {
          recordUnsupportedImport(sourcePath, rawImportPath, condition, unresolvedReason);
          continue;
        }
        if (visited.has(importPath)) continue;
        const importedFile = getFile(importPath);
        if (!importedFile) {
          recordUnsupportedImport(sourcePath, rawImportPath, condition, 'not_in_inventory');
          continue;
        }
        visited.add(importPath);
        const importCondition = condition;
        const importedParsed = await parseXmlFile(importedFile.relativePath);
        if (!importedParsed) continue;
        output.push({ path: importedFile.relativePath, parsed: importedParsed, condition: importCondition });
        output.push(...await collectLocalImports(importedFile.relativePath, importedParsed, visited, importCondition ? [importCondition] : []));
      }
      return output;
    };

    const projectFiles = files.filter((file) => projectKind(file.relativePath));
    const projects = [];
    const projectByPath = new Map();
    const projectOccurrences = new Map();
    for (const file of projectFiles) {
      const parsed = await parseXmlFile(file.relativePath);
      if (!parsed) continue;
      const projectId = stableProjectId(file.relativePath, '.NET');
      const project = {
        project_id: projectId,
        project_type: file.manifest?.type ?? '.NET project',
        ecosystem: '.NET',
        manifest_path: file.relativePath,
        target_frameworks: [],
        framework_references: [],
        project_references: [],
        runtime: { status: 'not_detected', versions: [] }
      };
      const projectDirectory = posixDirectory(file.relativePath);
      const buildConfigPaths = ancestors(file.relativePath).flatMap((directory) => [...BUILD_FILES].map((name) => directory ? `${directory}/${name}` : name))
        .filter((relativePath) => getFile(relativePath)).map(canonicalPath);
      const propertySourcePaths = [file.relativePath, ...buildConfigPaths.filter((candidate) => !candidate.toLowerCase().endsWith('directory.packages.props'))];
      const propertySources = [];
      for (const sourcePath of propertySourcePaths) {
        const sourceParsed = await parseXmlFile(sourcePath);
        if (!sourceParsed) continue;
        propertySources.push({ path: sourcePath, parsed: sourceParsed, condition: null });
        propertySources.push(...await collectLocalImports(sourcePath, sourceParsed));
      }
      for (const source of propertySources) {
        project.target_frameworks.push(...propertyDeclarations(source.parsed, ['TargetFramework', 'TargetFrameworks'], source.path, 'project_target_framework', source.condition));
      }
      const referenceGroups = [
        ...itemDeclarations(parsed, 'FrameworkReference', file.relativePath).map((item) => ({ ...item, reference_type: 'framework' })),
        ...itemDeclarations(parsed, 'ProjectReference', file.relativePath).map((item) => ({ ...item, reference_type: 'project' }))
      ];
      project.framework_references = referenceGroups.filter((item) => item.reference_type === 'framework').map((item) => ({
        name: item.name, condition: item.condition, evidence_file_path: item.evidence_file_path,
        detection_method: 'framework_reference'
      }));
      project.project_references = referenceGroups.filter((item) => item.reference_type === 'project').map((item) => {
        const targetPath = normalizeContainedPath(projectDirectory, item.name);
        const targetProject = targetPath ? projectFiles.find((candidate) => candidate.relativePath.toLowerCase() === targetPath.toLowerCase()) : null;
        const targetId = targetProject ? stableProjectId(targetProject.relativePath, '.NET') : null;
        return {
          target_path: targetProject?.relativePath ?? targetPath,
          target_project_id: targetId,
          condition: item.condition,
          evidence_file_path: item.evidence_file_path,
          status: targetProject ? 'resolved' : 'unresolved'
        };
      });
      projects.push(project);
      projectByPath.set(file.relativePath.toLowerCase(), project);
      projectOccurrences.set(file.relativePath, { parsed, projectDirectory });
    }

    const centralFilesByDirectory = new Map();
    for (const file of files.filter((candidate) => path.posix.basename(candidate.relativePath).toLowerCase() === 'directory.packages.props')) {
      const parsed = await parseXmlFile(file.relativePath);
      if (!parsed) continue;
      const declarations = itemDeclarations(parsed, 'PackageVersion', file.relativePath);
      for (const imported of await collectLocalImports(file.relativePath, parsed)) {
        declarations.push(...itemDeclarations(imported.parsed, 'PackageVersion', imported.path, imported.condition));
      }
      centralFilesByDirectory.set(file.relativePath.toLowerCase(), declarations);
    }

    const lockVersionsByDirectory = new Map();
    for (const file of files.filter((candidate) => path.posix.basename(candidate.relativePath).toLowerCase() === 'packages.lock.json')) {
      try {
        const contents = await readFileInsideRoot(context.rootPath, file.absolutePath, { maxBytes: context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024 });
        const parsed = JSON.parse(contents);
        analyzedFiles.add(file.relativePath);
        lockVersionsByDirectory.set(posixDirectory(file.relativePath), lockfileVersions(parsed));
      } catch {
        incomplete = true;
        fileErrors.push({ path: file.relativePath, code: 'MANIFEST_PARSE_FAILED', message: 'A .NET lockfile could not be parsed.' });
      }
    }

    const dependencies = [];
    for (const projectFile of projectFiles) {
      const project = projectByPath.get(projectFile.relativePath.toLowerCase());
      const projectOccurrence = projectOccurrences.get(projectFile.relativePath);
      if (!project || !projectOccurrence) continue;
      const packageDeclarations = [
        ...itemDeclarations(projectOccurrence.parsed, 'PackageReference', projectFile.relativePath)
      ];
      for (const imported of await collectLocalImports(projectFile.relativePath, projectOccurrence.parsed)) {
        packageDeclarations.push(...itemDeclarations(imported.parsed, 'PackageReference', imported.path, imported.condition));
      }
      for (const buildConfigPath of ancestors(projectFile.relativePath).flatMap((directory) => [...BUILD_FILES].filter((name) => name !== 'directory.packages.props').map((name) => directory ? `${directory}/${name}` : name))) {
        const resolvedBuildConfig = getFile(buildConfigPath);
        if (!resolvedBuildConfig) continue;
        const parsed = await parseXmlFile(resolvedBuildConfig.relativePath);
        if (parsed) {
          packageDeclarations.push(...itemDeclarations(parsed, 'PackageReference', resolvedBuildConfig.relativePath));
          for (const imported of await collectLocalImports(resolvedBuildConfig.relativePath, parsed)) {
            packageDeclarations.push(...itemDeclarations(imported.parsed, 'PackageReference', imported.path, imported.condition));
          }
        }
      }
      const packageConfigurationPaths = ancestors(projectFile.relativePath).map((directory) => (directory ? `${directory}/directory.packages.props` : 'directory.packages.props').toLowerCase());
      const central = packageConfigurationPaths.flatMap((relativePath) => (centralFilesByDirectory.get(relativePath) ?? []));
      const lock = [...lockVersionsByDirectory.entries()]
        .filter(([directory]) => projectOccurrence.projectDirectory === directory || projectOccurrence.projectDirectory.startsWith(directory ? `${directory}/` : ''))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1];
      for (const declaration of packageDeclarations) {
        const centralCandidates = central.filter((item) => item.name.toLowerCase() === declaration.name.toLowerCase());
        const centralVersion = centralCandidates.length === 1 ? centralCandidates[0] : null;
        const declaredVersion = declaration.version ?? centralVersion?.version ?? null;
        const versionSource = declaration.version ? 'project' : centralVersion ? 'central_package_management' : 'missing';
        const condition = declaration.condition ?? centralVersion?.condition ?? null;
        const safeDeclaredVersion = declaredVersion === null ? null : safeText(declaredVersion, 128);
        const literalDeclaration = safeDeclaredVersion && !safeDeclaredVersion.includes('$(') && !condition;
        const lockCandidates = literalDeclaration
          ? (lock?.get(declaration.name) ?? []).filter((item) => lockRequestMatches(safeDeclaredVersion, item.requested))
          : [];
        const resolvedVersions = new Set(lockCandidates.map((item) => item.resolved));
        const resolvedVersion = resolvedVersions.size === 1 ? [...resolvedVersions][0] : null;
        const versionStatus = resolvedVersion ? 'resolved'
          : !safeDeclaredVersion ? 'missing'
            : literalDeclaration ? 'declared' : 'unresolved';
        dependencies.push({
          project_id: project.project_id,
          name: declaration.name,
          version: safeVersion(safeDeclaredVersion),
          declared_version: safeVersion(safeDeclaredVersion),
          resolved_version: resolvedVersion,
          version_source: versionSource,
          version_status: versionStatus,
          ecosystem: '.NET',
          manifest_path: declaration.evidence_file_path,
          condition,
          classification: 'direct',
          direct: true,
          development: false,
          optional: false,
          version_unresolved: versionStatus === 'missing' || versionStatus === 'unresolved',
          parse_status: 'parsed'
        });
      }
    }

    const sdkConstraints = [];
    const globalFiles = files.filter((file) => path.posix.basename(file.relativePath).toLowerCase() === 'global.json');
    for (const file of globalFiles) {
      try {
        const contents = await readFileInsideRoot(context.rootPath, file.absolutePath, { maxBytes: context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024 });
        const record = sdkRecord(file.relativePath, JSON.parse(contents));
        analyzedFiles.add(file.relativePath);
        if (record) sdkConstraints.push(record);
      } catch {
        incomplete = true;
        fileErrors.push({ path: file.relativePath, code: 'MANIFEST_PARSE_FAILED', message: 'The .NET SDK configuration could not be parsed.' });
      }
    }

    const solutionMemberships = [];
    for (const file of files.filter((candidate) => ['.sln', '.slnx'].includes(path.posix.extname(candidate.relativePath).toLowerCase()))) {
      try {
        const contents = await readFileInsideRoot(context.rootPath, file.absolutePath, { maxBytes: context.options?.maxFileSizeBytes ?? 5 * 1024 * 1024 });
        analyzedFiles.add(file.relativePath);
        const entries = parseSolution(file.relativePath, contents, file.relativePath.toLowerCase().endsWith('.slnx'));
        for (const entry of entries) {
          const project = projectByPath.get(entry.project_path.toLowerCase());
          solutionMemberships.push({
            solution_path: file.relativePath,
            project_path: project?.manifest_path ?? entry.project_path,
            project_id: project?.project_id ?? null,
            solution_guid: entry.solution_guid,
            status: project ? 'resolved' : 'unresolved'
          });
        }
      } catch {
        incomplete = true;
        fileErrors.push({ path: file.relativePath, code: 'MANIFEST_PARSE_FAILED', message: 'A .NET solution could not be parsed.' });
      }
    }

    return {
      projects: projects.sort((left, right) => left.manifest_path.localeCompare(right.manifest_path)),
      sdk_constraints: sdkConstraints.sort((left, right) => left.evidence_file_path.localeCompare(right.evidence_file_path)),
      dependencies: dependencies.sort((left, right) => left.manifest_path.localeCompare(right.manifest_path) || left.name.localeCompare(right.name)),
      solution_memberships: solutionMemberships.sort((left, right) => left.solution_path.localeCompare(right.solution_path) || left.project_path.localeCompare(right.project_path)),
      unsupported_imports: unsupportedImports.sort((left, right) => left.source_file_path.localeCompare(right.source_file_path)
        || String(left.project_expression).localeCompare(String(right.project_expression))),
      analyzed_files: [...analyzedFiles].sort(),
      file_errors: fileErrors,
      warnings,
      incomplete
    };
  }
}
