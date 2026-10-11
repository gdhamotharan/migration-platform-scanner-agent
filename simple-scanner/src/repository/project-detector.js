import path from 'node:path';
import { stableProjectId } from './project-id.js';

function directoryOf(relativePath) {
  const directory = path.posix.dirname(relativePath);
  return directory === '.' ? '' : directory;
}

function isParentDirectory(parent, child) {
  return parent !== child && (parent === '' || child.startsWith(`${parent}/`));
}

export function detectProjects(files, dotnet = {}) {
  const manifests = files.filter((file) => file.manifest?.project);
  const primary = manifests.filter((file) => file.manifest.role === 'primary');
  const projects = primary.map((file) => ({
    project_type: file.manifest.type,
    ecosystem: file.manifest.ecosystem,
    manifest_path: file.relativePath,
    project_id: stableProjectId(file.relativePath, file.manifest.ecosystem),
    project_root: directoryOf(file.relativePath),
    manifest_paths: [file.relativePath],
    relationships: { solution_ids: [], referenced_project_ids: [], references: [] }
  }));

  const lockfiles = [
    ...manifests.filter((file) => file.manifest.role === 'lockfile'),
    ...files.filter((file) => path.posix.basename(file.relativePath).toLowerCase() === 'packages.lock.json')
  ];
  for (const lockfile of lockfiles) {
    const lockDirectory = directoryOf(lockfile.relativePath);
    const matchingProject = projects.filter((project) => project.ecosystem === lockfile.manifest.ecosystem
      && !(lockfile.manifest.ecosystem === '.NET' && project.project_type === '.NET solution')
      && (project.project_root === lockDirectory || lockDirectory.startsWith(`${project.project_root}/`)))
      .sort((left, right) => right.project_root.length - left.project_root.length)[0];
    if (matchingProject) {
      if (!matchingProject.manifest_paths.includes(lockfile.relativePath)) matchingProject.manifest_paths.push(lockfile.relativePath);
    } else {
      if (lockfile.manifest.ecosystem === '.NET' && lockfile.manifest.type === '.NET lockfile') continue;
      projects.push({
        project_type: lockfile.manifest.type,
        ecosystem: lockfile.manifest.ecosystem,
        manifest_path: lockfile.relativePath,
        project_id: stableProjectId(lockfile.relativePath, lockfile.manifest.ecosystem),
        project_root: lockDirectory,
        manifest_paths: [lockfile.relativePath],
        relationships: { solution_ids: [], referenced_project_ids: [], references: [] }
      });
    }
  }

  for (const project of projects) {
    const parent = projects
      .filter((candidate) => candidate !== project && candidate.ecosystem === project.ecosystem
        && isParentDirectory(candidate.project_root, project.project_root))
      .sort((left, right) => right.project_root.length - left.project_root.length)[0];
    project.parent_project_path = parent?.manifest_path ?? null;
    project.manifest_paths.sort((left, right) => left.localeCompare(right));
  }

  const projectByManifest = new Map(projects.map((project) => [project.manifest_path, project]));
  for (const membership of dotnet.solution_memberships ?? []) {
    const solution = projectByManifest.get(membership.solution_path);
    const member = projectByManifest.get(membership.project_path);
    if (!solution || !member || membership.status !== 'resolved') continue;
    member.relationships.solution_ids.push(solution.project_id);
  }
  for (const metadata of dotnet.projects ?? []) {
    const project = projectByManifest.get(metadata.manifest_path);
    if (!project) continue;
    for (const reference of metadata.project_references ?? []) {
      const target = reference.target_path ? projectByManifest.get(reference.target_path) : null;
      const resolved = target && reference.status === 'resolved';
      project.relationships.references.push({
        target_path: reference.target_path,
        target_project_id: resolved ? target.project_id : null,
        status: resolved ? 'resolved' : 'unresolved'
      });
      if (resolved) project.relationships.referenced_project_ids.push(target.project_id);
    }
  }
  for (const project of projects) {
    project.relationships.solution_ids = [...new Set(project.relationships.solution_ids)].sort();
    project.relationships.referenced_project_ids = [...new Set(project.relationships.referenced_project_ids)].sort();
    project.relationships.references.sort((left, right) => String(left.target_path).localeCompare(String(right.target_path)));
  }

  return projects.sort((left, right) => left.manifest_path.localeCompare(right.manifest_path));
}
