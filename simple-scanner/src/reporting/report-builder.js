import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toReportPath } from '../utils/safe-path.js';
import { stableProjectId } from '../repository/project-id.js';
import { validateReport } from './json-reporter.js';
import { isSemver } from '../utils/semver.js';

const KNOWN_CODES = new Set([
  'GRADLE_RESOLUTION_UNSUPPORTED', 'MANIFEST_PARSE_FAILED', 'FILE_TOO_LARGE', 'FILE_SKIPPED',
  'MAX_FILES_REACHED', 'DIRECTORY_READ_FAILED', 'FILE_READ_FAILED', 'ANALYZER_FAILED',
  'ANALYZER_NOT_FOUND', 'ANALYZER_UNSUPPORTED', 'ANALYZER_DEPENDENCY_UNAVAILABLE',
  'SCAN_CANCELLED', 'SCAN_ERROR', 'OUTPUT_WRITE_FAILED'
]);
const MESSAGE_BY_CODE = Object.freeze({
  GRADLE_RESOLUTION_UNSUPPORTED: 'Gradle dependency resolution is not implemented in V1.',
  MANIFEST_PARSE_FAILED: 'A dependency manifest could not be parsed.',
  FILE_TOO_LARGE: 'A file was skipped because it exceeded the configured size limit.',
  FILE_SKIPPED: 'A file was skipped according to scanner configuration.',
  MAX_FILES_REACHED: 'The configured file limit was reached; this report is partial.',
  DIRECTORY_READ_FAILED: 'A repository directory could not be read.',
  FILE_READ_FAILED: 'A repository file could not be read.',
  ANALYZER_FAILED: 'An analyzer failed; other analyzer results were retained.',
  ANALYZER_NOT_FOUND: 'A requested analyzer is not available.',
  ANALYZER_UNSUPPORTED: 'A requested analyzer does not support this scan scope.',
  SCAN_CANCELLED: 'The scan was cancelled before the requested scope was complete.',
  SCAN_ERROR: 'A scanner operation could not be completed.',
  OUTPUT_WRITE_FAILED: 'The report could not be written.'
});
const SAFE_DEPENDENCY_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+:-]{0,199}$/;
const SAFE_DEPENDENCY_VERSION = /^[A-Za-z0-9.*+!<>=~^|,_:/$(){} -]{1,128}$/;
const SECRET_PATTERN = /(?:api[_-]?(?:key|token)|token|secret|password|credential|private[_ -]?key)\s*[:=]|\b(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{40,}\b/i;
const SECRET_PATH_MARKER = /(?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|private[_ -]?key|authorization|bearer)\s*(?:[:=]|[_-])\s*\S+/i;

function numberOr(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function redactPathSegments(value) {
  return value.split(/([\\/])/).map((segment) => {
    if (segment === '/' || segment === '\\') return segment;
    return SECRET_PATTERN.test(segment) || SECRET_PATH_MARKER.test(segment) ? '[redacted]' : segment;
  }).join('');
}

function reportPath(rootPath, inputPath, includeAbsolutePaths) {
  if (typeof inputPath !== 'string' || !inputPath) return undefined;
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(rootPath, inputPath);
  return redactPathSegments(toReportPath(rootPath, absolutePath, includeAbsolutePaths));
}

function cleanFile(file, rootPath, includeAbsolutePaths) {
  return {
    path: reportPath(rootPath, file.relativePath, includeAbsolutePaths),
    extension: typeof file.extension === 'string' ? file.extension : '',
    file_format: typeof file.fileFormat === 'string' ? file.fileFormat : null,
    size_bytes: numberOr(file.sizeBytes),
    category: typeof file.category === 'string' ? file.category : 'other',
    language: typeof file.language === 'string' ? file.language : null,
    is_project_file: Boolean(file.flags?.project),
    is_build_file: Boolean(file.flags?.build),
    is_dependency_file: Boolean(file.flags?.dependency),
    is_test_file: Boolean(file.flags?.test),
    is_configuration_file: Boolean(file.flags?.configuration),
    is_documentation_file: Boolean(file.flags?.documentation)
  };
}

function cleanProject(project, rootPath, includeAbsolutePaths) {
  const manifestPath = reportPath(rootPath, project.manifest_path, includeAbsolutePaths);
  const relationships = project.relationships ?? {};
  return {
    project_id: typeof project.project_id === 'string' ? project.project_id : stableProjectId(project.manifest_path, project.ecosystem),
    project_type: String(project.project_type ?? 'Unknown').slice(0, 80),
    ecosystem: String(project.ecosystem ?? 'unknown').slice(0, 80),
    manifest_path: manifestPath,
    project_root: project.project_root ? reportPath(rootPath, project.project_root, includeAbsolutePaths) : '.',
    manifest_paths: (project.manifest_paths ?? []).map((item) => reportPath(rootPath, item, includeAbsolutePaths)),
    parent_project_path: project.parent_project_path
      ? reportPath(rootPath, project.parent_project_path, includeAbsolutePaths) : null,
    relationships: {
      solution_ids: (relationships.solution_ids ?? []).filter((id) => typeof id === 'string'),
      referenced_project_ids: (relationships.referenced_project_ids ?? []).filter((id) => typeof id === 'string'),
      references: (relationships.references ?? []).map((item) => ({
        target_path: item.target_path ? reportPath(rootPath, item.target_path, includeAbsolutePaths) : null,
        target_project_id: typeof item.target_project_id === 'string' ? item.target_project_id : null,
        status: item.status === 'resolved' ? 'resolved' : 'unresolved'
      }))
    }
  };
}

function cleanDependency(item, rootPath, includeAbsolutePaths) {
  const validName = typeof item.name === 'string' && SAFE_DEPENDENCY_NAME.test(item.name) && !SECRET_PATTERN.test(item.name);
  const validVersion = typeof item.version === 'string' && SAFE_DEPENDENCY_VERSION.test(item.version)
    && !item.version.includes('://') && !SECRET_PATTERN.test(item.version);
  const classifications = new Set(['direct', 'development', 'optional']);
  return {
    name: validName ? item.name : null,
    version: validVersion ? item.version : null,
    declared_version: typeof item.declared_version === 'string' && SAFE_DEPENDENCY_VERSION.test(item.declared_version)
      && !item.declared_version.includes('://') && !SECRET_PATTERN.test(item.declared_version) ? item.declared_version : null,
    resolved_version: typeof item.resolved_version === 'string' && SAFE_DEPENDENCY_VERSION.test(item.resolved_version)
      && !item.resolved_version.includes('://') && !SECRET_PATTERN.test(item.resolved_version) ? item.resolved_version : null,
    version_source: ['manifest', 'project', 'central_package_management', 'missing', 'lockfile'].includes(item.version_source)
      ? item.version_source : item.manifest_path ? 'manifest' : 'missing',
    version_status: ['declared', 'resolved', 'unresolved', 'missing'].includes(item.version_status)
      ? item.version_status : validVersion ? 'declared' : 'missing',
    ecosystem: String(item.ecosystem ?? 'unknown').slice(0, 80),
    manifest_path: reportPath(rootPath, item.manifest_path, includeAbsolutePaths),
    ...(typeof item.project_id === 'string' ? { project_id: item.project_id } : {}),
    ...(typeof item.condition === 'string' && item.condition.length <= 512 && !SECRET_PATTERN.test(item.condition)
      ? { condition: item.condition } : {}),
    classification: classifications.has(item.classification) ? item.classification : 'direct',
    direct: Boolean(item.direct),
    development: Boolean(item.development),
    optional: Boolean(item.optional),
    version_unresolved: Boolean(item.version_unresolved) || !validVersion,
    parse_status: item.parse_status === 'parsed' && validName ? 'parsed' : 'unparsed'
  };
}

function cleanTechnology(item, rootPath, includeAbsolutePaths) {
  const technology = String(item.technology ?? 'Unknown').slice(0, 80);
  const detectionMethod = ['manifest_dependency', 'framework_reference', 'configuration', 'file_pattern', 'project_target_framework'].includes(item.detection_method)
    ? item.detection_method : 'manifest_dependency';
  const confidence = ['manifest_declared', 'inferred'].includes(item.confidence) ? item.confidence : 'manifest_declared';
  return {
    technology_id: typeof item.technology_id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(item.technology_id)
      ? item.technology_id : `technology-${technology.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    technology,
    category: ['library', 'framework', 'project_target_framework', 'sdk_constraint', 'runtime'].includes(item.category) ? item.category : 'library',
    ecosystem: String(item.ecosystem ?? 'unknown').slice(0, 80),
    detection_method: detectionMethod,
    evidence_file_path: reportPath(rootPath, item.evidence_file_path, includeAbsolutePaths),
    evidence_type: String(item.evidence_type ?? 'manifest_dependency').slice(0, 80),
    ...(typeof item.project_id === 'string' ? { project_id: item.project_id } : {}),
    ...(typeof item.evidence_identity === 'string' ? { evidence_identity: item.evidence_identity.slice(0, 240) } : {}),
    ...(typeof item.declared_version === 'string' && SAFE_DEPENDENCY_VERSION.test(item.declared_version)
      && !SECRET_PATTERN.test(item.declared_version) ? { declared_version: item.declared_version } : {}),
    ...(item.version_scope === 'package' || item.version_scope === 'sdk_constraint' ? { version_scope: item.version_scope } : {}),
    ...(typeof item.declared_value === 'string' && item.declared_value.length <= 512 && !SECRET_PATTERN.test(item.declared_value)
      ? { declared_value: item.declared_value } : {}),
    ...(typeof item.condition === 'string' && item.condition.length <= 512 && !SECRET_PATTERN.test(item.condition)
      ? { condition: item.condition } : {}),
    confidence,
    analyzer_id: String(item.analyzer_id ?? 'technologies').replace(/[^a-z0-9_-]/gi, '').slice(0, 64),
    analyzer_version: isSemver(item.analyzer_version)
      ? item.analyzer_version : '1.0.0',
    explanation: String(item.explanation ?? `${technology} is based on static manifest evidence.`).slice(0, 300)
  };
}

function cleanDotnet(dotnet = {}, rootPath, includeAbsolutePaths) {
  const cleanPath = (value) => value ? reportPath(rootPath, value, includeAbsolutePaths) : null;
  const projects = (dotnet.projects ?? []).map((project) => ({
    project_id: String(project.project_id),
    manifest_path: cleanPath(project.manifest_path),
    target_frameworks: (project.target_frameworks ?? []).map((item) => ({
      property_name: ['TargetFramework', 'TargetFrameworks'].includes(item.property_name) ? item.property_name : 'TargetFramework',
      declared_value: String(item.declared_value).slice(0, 512),
      condition: typeof item.condition === 'string' ? item.condition.slice(0, 512) : null,
      evidence_file_path: cleanPath(item.evidence_file_path),
      detection_method: 'project_target_framework',
      status: item.status === 'unresolved' ? 'unresolved' : 'declared'
    })),
    framework_references: (project.framework_references ?? []).map((item) => ({
      name: String(item.name).slice(0, 200),
      condition: typeof item.condition === 'string' ? item.condition.slice(0, 512) : null,
      evidence_file_path: cleanPath(item.evidence_file_path),
      detection_method: 'framework_reference'
    })),
    project_references: (project.project_references ?? []).map((item) => ({
      target_path: cleanPath(item.target_path),
      target_project_id: typeof item.target_project_id === 'string' ? item.target_project_id : null,
      condition: typeof item.condition === 'string' ? item.condition.slice(0, 512) : null,
      evidence_file_path: cleanPath(item.evidence_file_path),
      status: item.status === 'resolved' ? 'resolved' : 'unresolved'
    })),
    runtime: { status: 'not_detected', versions: [] }
  }));
  const sdkConstraints = (dotnet.sdk_constraints ?? []).map((item) => ({
    declared_version: String(item.declared_version).slice(0, 128),
    roll_forward: typeof item.roll_forward === 'string' ? item.roll_forward.slice(0, 80) : null,
    allow_prerelease: typeof item.allow_prerelease === 'boolean' ? item.allow_prerelease : null,
    evidence_file_path: cleanPath(item.evidence_file_path),
    property_name: 'sdk.version',
    detection_method: 'global_json',
    status: item.status === 'unresolved' ? 'unresolved' : 'declared'
  }));
  return {
    projects,
    sdk_constraints: sdkConstraints,
    solution_memberships: (dotnet.solution_memberships ?? []).map((item) => ({
      solution_path: cleanPath(item.solution_path),
      project_path: cleanPath(item.project_path),
      project_id: typeof item.project_id === 'string' ? item.project_id : null,
      solution_guid: typeof item.solution_guid === 'string' ? item.solution_guid.slice(0, 64) : null,
      status: item.status === 'resolved' ? 'resolved' : 'unresolved'
    })),
    runtime: { status: 'not_detected', versions: [] }
  };
}

function cleanExcluded(item, rootPath, includeAbsolutePaths) {
  const reasons = new Set([
    'excluded_directory', 'sensitive_directory', 'sensitive_file', 'symlink_not_followed',
    'generated_artifact', 'binary_file', 'file_too_large', 'binary_content', 'outside_repository', 'max_files'
  ]);
  return {
    path: reportPath(rootPath, item.relativePath, includeAbsolutePaths),
    reason: reasons.has(item.reason) ? item.reason : 'scanner_exclusion',
    ...(item.itemType ? { item_type: item.itemType } : {}),
    ...(typeof item.category === 'string' ? { category: item.category } : {}),
    ...(Number.isFinite(item.sizeBytes) ? { size_bytes: numberOr(item.sizeBytes) } : {})
  };
}

function cleanDiagnostic(item, rootPath, includeAbsolutePaths, fallbackCode) {
  const code = KNOWN_CODES.has(item.code) ? item.code : fallbackCode;
  const inputPath = item.file_path ?? item.path;
  return {
    code,
    ...(inputPath ? { file_path: reportPath(rootPath, inputPath, includeAbsolutePaths) } : {}),
    ...(item.analyzer_id ? { analyzer_id: String(item.analyzer_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) } : {}),
    message: MESSAGE_BY_CODE[code] ?? MESSAGE_BY_CODE[fallbackCode]
  };
}

function cleanStatistics(languageResult, files, filesByCategory, excludedItems) {
  const input = languageResult?.statistics ?? {};
  const byCategory = filesByCategory ?? {};
  const countCategory = (category) => numberOr(byCategory[category]);
  const excludedGenerated = excludedItems.filter((item) => item.reason === 'generated_artifact').length;
  return {
    files_by_category: byCategory,
    source_files_analyzed: numberOr(input.source_code_files_analyzed),
    source_code_size_bytes: numberOr(input.source_code_size_bytes, numberOr(input.total_source_size_bytes)),
    source_code_lines: numberOr(input.source_code_lines, numberOr(input.total_lines)),
    source_code_blank_lines: numberOr(input.source_code_blank_lines, numberOr(input.blank_lines)),
    test_files: countCategory('test_code'),
    test_files_analyzed: numberOr(input.test_code_files_analyzed),
    test_files_excluded_by_option: numberOr(input.test_files_excluded),
    test_code_size_bytes: numberOr(input.test_code_size_bytes),
    test_code_lines: numberOr(input.test_code_lines),
    test_code_blank_lines: numberOr(input.test_code_blank_lines),
    configuration_files: countCategory('configuration'),
    manifest_files: countCategory('project_manifest') + countCategory('dependency_manifest') + countCategory('build_configuration'),
    documentation_files: countCategory('documentation'),
    generated_files_excluded: excludedGenerated,
    comment_metrics: {
      available: false,
      status: 'unavailable',
      reason: 'No language-aware comment parser is implemented in V1.',
      unavailable_files: numberOr(input.comment_count_unavailable_files)
    }
  };
}

export function buildReport(scanState) {
  const rootPath = path.resolve(scanState.rootPath);
  const includeAbsolutePaths = Boolean(scanState.options?.includeAbsolutePaths);
  const analyzerResults = scanState.analyzerResults ?? {};
  const languageResult = analyzerResults.language ?? {};
  const dependencyResult = analyzerResults.dependencies ?? {};
  const dotnetResult = scanState.dotnetResult ?? analyzerResults.dotnet ?? {};
  const rawDependencies = [
    ...(dependencyResult.dependencies ?? []).filter((item) => item.ecosystem !== '.NET'),
    ...(dotnetResult.dependencies ?? []),
    ...(dependencyResult.dependencies ?? []).filter((item) => item.ecosystem === '.NET' && !dotnetResult.dependencies)
  ];
  const files = (scanState.files ?? []).map((file) => cleanFile(file, rootPath, includeAbsolutePaths))
    .sort((left, right) => left.path.localeCompare(right.path));
  const exclusions = [
    ...(scanState.excludedItems ?? []),
    ...(languageResult.excluded_items ?? []).map((item) => ({ relativePath: item.path, reason: item.reason, itemType: 'file' }))
  ].map((item) => cleanExcluded(item, rootPath, includeAbsolutePaths))
    .sort((left, right) => left.path.localeCompare(right.path));
  const analyzerFailures = (scanState.analyzerFailures ?? []).map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'ANALYZER_FAILED'));
  const errors = [
    ...(scanState.errors ?? []).map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'SCAN_ERROR')),
    ...(languageResult.file_errors ?? []).map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'FILE_READ_FAILED')),
    ...(dependencyResult.file_errors ?? []).map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'MANIFEST_PARSE_FAILED')),
    ...(dotnetResult.file_errors ?? []).map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'MANIFEST_PARSE_FAILED')),
    ...analyzerFailures
  ];
  const rawWarnings = [
    ...(scanState.warnings ?? []),
    ...(dependencyResult.warnings ?? []),
    ...(dotnetResult.warnings ?? [])
  ];
  const warnings = rawWarnings.map((item) => cleanDiagnostic(item, rootPath, includeAbsolutePaths, 'SCAN_ERROR'));
  const executions = (scanState.analyzerExecutions ?? []).map((item) => ({
    analyzer_id: String(item.analyzer_id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    version: isSemver(item.version) ? item.version : null,
    status: ['completed', 'failed', 'skipped', 'unsupported', 'cancelled'].includes(item.status) ? item.status : 'failed',
    selected: Boolean(item.selected),
    depends_on: (item.depends_on ?? []).filter((id) => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id))
  }));
  const analyzerCounts = scanState.analyzerExecutionCounts ?? executions.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { completed: 0, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 });
  if (scanState.failed && errors.length === 0) errors.push(cleanDiagnostic({ code: 'SCAN_ERROR' }, rootPath, includeAbsolutePaths, 'SCAN_ERROR'));
  const selectedAnalyzerIncomplete = executions.some((item) => item.selected && item.status !== 'completed');
  const complete = Boolean(scanState.complete)
    && !scanState.failed
    && !scanState.cancelled
    && !selectedAnalyzerIncomplete
    && !dependencyResult.incomplete
    && !dotnetResult.incomplete
    && errors.length === 0
    && analyzerFailures.length === 0;
  const status = scanState.failed ? 'failed'
    : !complete ? 'partial'
      : warnings.length > 0 ? 'completed_with_warnings' : 'completed';
  const startedAt = scanState.startedAt ?? new Date().toISOString();
  const completedAt = scanState.completedAt ?? new Date().toISOString();
  const fileCounts = scanState.fileCounts ?? {
    files_discovered: files.length + exclusions.filter((item) => item.item_type === 'file').length,
    files_included: files.length,
    files_analyzed: new Set([
      ...(languageResult.analyzed_files ?? []),
      ...(dependencyResult.analyzed_files ?? []),
      ...(dotnetResult.analyzed_files ?? [])
    ]).size,
    files_excluded: exclusions.filter((item) => ['sensitive_file', 'generated_artifact', 'binary_file'].includes(item.reason)).length,
    files_skipped: exclusions.filter((item) => ['file_too_large', 'binary_content', 'max_files'].includes(item.reason)).length,
    files_failed: errors.filter((item) => item.file_path).length,
    directories_excluded: exclusions.filter((item) => item.item_type === 'directory').length,
    directories_failed: errors.filter((item) => item.code === 'DIRECTORY_READ_FAILED').length,
    unvisited_files_unknown: false
  };
  const totalFiles = numberOr(fileCounts.files_discovered);
  const discoveredSizes = [
    ...(scanState.files ?? []).map((file) => file.sizeBytes),
    ...(scanState.excludedItems ?? []).map((item) => item.sizeBytes)
  ];
  const computedSize = discoveredSizes.reduce((total, size) => total + numberOr(size), 0);
  const filesByCategory = scanState.filesByCategory ?? files.reduce((counts, file) => {
    counts[file.category] = (counts[file.category] ?? 0) + 1;
    return counts;
  }, {});
  const report = {
    schema_version: '2.0',
    scanner: { name: 'Local Source Intelligence Scanner', version: '0.1.0' },
    analysis: {
      analysis_id: scanState.analysisId ?? randomUUID(),
      started_at: startedAt,
      completed_at: completedAt,
      status,
      complete,
      cancelled: Boolean(scanState.cancelled),
      duration_ms: numberOr(scanState.durationMs),
    },
    repository: {
      name: redactPathSegments(path.basename(rootPath)),
      root_path: includeAbsolutePaths ? redactPathSegments(rootPath) : '.',
      total_files: totalFiles,
      total_size_bytes: numberOr(scanState.totalDiscoveredSizeBytes, computedSize),
      total_discovered_size_bytes: numberOr(scanState.totalDiscoveredSizeBytes, computedSize),
      total_included_size_bytes: numberOr(scanState.totalIncludedSizeBytes, files.reduce((total, file) => total + numberOr(file.size_bytes), 0)),
      file_counts: fileCounts
    },
    files,
    languages: (languageResult.languages ?? []).map((item) => ({
      name: String(item.name ?? 'Unknown').slice(0, 80),
      file_count: numberOr(item.file_count),
      size_bytes: numberOr(item.size_bytes),
      lines: numberOr(item.lines),
      blank_lines: numberOr(item.blank_lines),
      line_count_status: 'available',
      comment_count_status: 'unavailable',
      comment_count_unavailable_files: numberOr(item.file_count)
    })),
    test_languages: (languageResult.test_languages ?? []).map((item) => ({
      name: String(item.name ?? 'Unknown').slice(0, 80),
      file_count: numberOr(item.file_count),
      size_bytes: numberOr(item.size_bytes),
      lines: numberOr(item.lines),
      blank_lines: numberOr(item.blank_lines),
      line_count_status: 'available',
      comment_count_status: 'unavailable',
      comment_count_unavailable_files: numberOr(item.file_count)
    })),
    projects: (scanState.projects ?? []).map((item) => cleanProject(item, rootPath, includeAbsolutePaths)),
    technologies: (analyzerResults.technologies ?? []).map((item) => cleanTechnology(item, rootPath, includeAbsolutePaths)),
    dependencies: rawDependencies.map((item) => cleanDependency(item, rootPath, includeAbsolutePaths))
      .sort((left, right) => String(left.manifest_path).localeCompare(String(right.manifest_path)) || String(left.name).localeCompare(String(right.name))),
    dotnet: cleanDotnet(dotnetResult, rootPath, includeAbsolutePaths),
    analyzers: { executions, counts: analyzerCounts },
    statistics: {
      ...cleanStatistics(languageResult, files, filesByCategory, exclusions),
      files_processed: numberOr(fileCounts.files_analyzed)
    },
    excluded_items: exclusions,
    errors,
    warnings
  };
  validateReport(report);
  return report;
}
