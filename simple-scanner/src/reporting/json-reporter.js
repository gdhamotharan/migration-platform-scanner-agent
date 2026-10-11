import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPORT_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../schemas/report-2.0.schema.json', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(REPORT_SCHEMA);
const STATUSES = new Set(['completed', 'completed_with_warnings', 'partial', 'failed']);

function assertSemanticConsistency(report) {
  const { analysis, repository } = report;
  const counts = repository.file_counts;
  const started = Date.parse(analysis.started_at);
  const completed = Date.parse(analysis.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new TypeError('Report timestamps are inconsistent.');
  }
  if (analysis.complete !== ['completed', 'completed_with_warnings'].includes(analysis.status)) {
    throw new TypeError('Report status and complete flag are inconsistent.');
  }
  if (analysis.cancelled && analysis.status !== 'partial') throw new TypeError('Cancelled reports must be partial.');
  const counterProblems = [];
  if (repository.total_files !== counts.files_discovered) counterProblems.push('total_files');
  if (repository.total_size_bytes !== repository.total_discovered_size_bytes) counterProblems.push('total_size_alias');
  if (counts.files_included !== report.files.length) counterProblems.push('files_included');
  if (counts.files_included > counts.files_discovered) counterProblems.push('included_exceeds_discovered');
  if (counts.files_analyzed > counts.files_included) counterProblems.push('analyzed_exceeds_included');
  if (counts.files_excluded > counts.files_discovered) counterProblems.push('excluded_exceeds_discovered');
  if (counts.files_skipped > counts.files_discovered) counterProblems.push('skipped_exceeds_discovered');
  if (counts.files_failed > counts.files_discovered) counterProblems.push('failed_exceeds_discovered');
  if (repository.total_included_size_bytes > repository.total_discovered_size_bytes) counterProblems.push('included_size_exceeds_discovered');
  const includedFileBytes = report.files.reduce((total, file) => total + file.size_bytes, 0);
  if (repository.total_included_size_bytes !== includedFileBytes) counterProblems.push(`included_size(${repository.total_included_size_bytes}:${includedFileBytes})`);
  if (counterProblems.length) throw new TypeError(`Report file counters are inconsistent: ${counterProblems.join(', ')}.`);
  if (report.statistics.files_processed !== counts.files_analyzed
    || report.statistics.source_files_analyzed + report.statistics.test_files_analyzed > counts.files_analyzed
    || report.statistics.test_files_analyzed > report.statistics.test_files) {
    throw new TypeError('Report statistics are inconsistent.');
  }
  const executionCounts = { completed: 0, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 };
  for (const execution of report.analyzers.executions) executionCounts[execution.status] += 1;
  for (const [status, count] of Object.entries(executionCounts)) {
    if (report.analyzers.counts[status] !== count) throw new TypeError('Analyzer execution counts are inconsistent.');
  }
  const filePaths = new Set(report.files.map((file) => file.path));
  const projectIds = new Set(report.projects.map((project) => project.project_id));
  const projectPaths = new Set(report.projects.map((project) => project.manifest_path));
  const projectsById = new Map(report.projects.map((project) => [project.project_id, project]));
  const requireEvidence = (evidencePath) => {
    if (typeof evidencePath !== 'string' || !filePaths.has(evidencePath)) {
      throw new TypeError('Report evidence path does not reference an inventoried file.');
    }
  };
  if (filePaths.size !== report.files.length || projectIds.size !== report.projects.length) {
    throw new TypeError('Report contains duplicate file or project identities.');
  }
  for (const project of report.projects) {
    requireEvidence(project.manifest_path);
    for (const manifestPath of project.manifest_paths) requireEvidence(manifestPath);
    if (project.parent_project_path && !projectPaths.has(project.parent_project_path)) {
      throw new TypeError('Parent project path does not reference a known project.');
    }
    for (const id of [...project.relationships.solution_ids, ...project.relationships.referenced_project_ids]) {
      if (!projectIds.has(id)) throw new TypeError('Project relationship points to an unknown project.');
    }
    for (const reference of project.relationships.references) {
      if (reference.status === 'resolved' && (!reference.target_project_id || !projectIds.has(reference.target_project_id))) {
        throw new TypeError('Resolved project reference has no matching project.');
      }
      if (reference.status === 'resolved' && projectsById.get(reference.target_project_id)?.manifest_path !== reference.target_path) {
        throw new TypeError('Resolved project reference path and ID disagree.');
      }
    }
  }
  for (const technology of report.technologies) {
    requireEvidence(technology.evidence_file_path);
    if (technology.project_id && !projectIds.has(technology.project_id)) throw new TypeError('Technology refers to an unknown project.');
    if (technology.version_scope === 'package' && technology.category === 'project_target_framework') {
      throw new TypeError('Target framework evidence cannot use package version scope.');
    }
  }
  for (const dependency of report.dependencies) {
    requireEvidence(dependency.manifest_path);
    if (dependency.version_status === 'resolved' && !dependency.resolved_version) throw new TypeError('Resolved dependency is missing its lockfile version.');
    if (dependency.version_status !== 'resolved' && dependency.resolved_version) throw new TypeError('Unresolved dependency contains a resolved version.');
    if (dependency.project_id && !projectIds.has(dependency.project_id)) throw new TypeError('Dependency refers to an unknown project.');
    if (dependency.version_unresolved !== ['unresolved', 'missing'].includes(dependency.version_status)) {
      throw new TypeError('Dependency version status and unresolved flag disagree.');
    }
  }
  for (const project of report.dotnet.projects) {
    requireEvidence(project.manifest_path);
    if (!projectIds.has(project.project_id)) throw new TypeError('Dotnet metadata refers to an unknown project.');
    for (const fact of project.target_frameworks) requireEvidence(fact.evidence_file_path);
    for (const fact of project.framework_references) requireEvidence(fact.evidence_file_path);
    for (const fact of project.project_references) {
      requireEvidence(fact.evidence_file_path);
      if (fact.status === 'resolved' && (!fact.target_project_id || !projectIds.has(fact.target_project_id))) {
        throw new TypeError('Resolved .NET project reference has no matching project.');
      }
      if (fact.status === 'resolved' && projectsById.get(fact.target_project_id)?.manifest_path !== fact.target_path) {
        throw new TypeError('Resolved .NET project reference path and ID disagree.');
      }
    }
  }
  for (const sdk of report.dotnet.sdk_constraints) requireEvidence(sdk.evidence_file_path);
  for (const membership of report.dotnet.solution_memberships) {
    requireEvidence(membership.solution_path);
    if (membership.status === 'resolved') requireEvidence(membership.project_path);
    if (membership.status === 'resolved' && (!membership.project_id || !projectIds.has(membership.project_id))) {
      throw new TypeError('Resolved solution membership has no matching project.');
    }
    if (membership.status === 'resolved' && projectsById.get(membership.project_id)?.manifest_path !== membership.project_path) {
      throw new TypeError('Resolved solution membership path and ID disagree.');
    }
  }
  if (report.dotnet.runtime.status === 'not_detected' && report.dotnet.runtime.versions.length > 0) {
    throw new TypeError('Undetected .NET runtime cannot have version claims.');
  }
  if (report.dotnet.runtime.status !== 'detected' && report.technologies.some((item) => item.category === 'runtime')) {
    throw new TypeError('Runtime technology evidence requires an independently detected runtime.');
  }
  if (analysis.status === 'completed' && report.warnings.length > 0) throw new TypeError('Completed reports cannot contain warnings.');
  if (analysis.status === 'completed_with_warnings' && report.warnings.length === 0) throw new TypeError('Warning status requires at least one warning.');
  if (analysis.status === 'failed' && report.errors.length === 0) throw new TypeError('Failed reports require an error.');
  if (analysis.complete && (counts.unvisited_files_unknown || counts.files_failed > 0 || counts.directories_failed > 0
    || report.errors.length > 0 || report.analyzers.executions.some((item) => item.selected && item.status !== 'completed'))) {
    throw new TypeError('Completed report includes unfinished work.');
  }
  return true;
}

export function validateReport(report) {
  if (!report || !validateSchema(report)) {
    const fields = (validateSchema.errors ?? []).slice(0, 8).map((item) => `${item.instancePath || '/'}:${item.keyword}`).join(', ');
    throw new TypeError(`Report does not match schema version 2.0.${fields ? ` Invalid fields: ${fields}.` : ''}`);
  }
  if (!STATUSES.has(report.analysis.status)) throw new TypeError('Report status is invalid.');
  assertSemanticConsistency(report);
  return true;
}

export function serializeReport(report) {
  validateReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}
