import { Analyzer } from './analyzer-registry.js';

export const TECHNOLOGY_RULES = Object.freeze([
  { technology_id: 'react', technology: 'React', category: 'library', ecosystem: 'Node.js', method: 'manifest_dependency', matches: (name) => ['react', 'react-dom'].includes(name.toLowerCase()) },
  { technology_id: 'spring-boot', technology: 'Spring Boot', category: 'framework', ecosystem: 'Maven', method: 'manifest_dependency', matches: (name) => name.toLowerCase().startsWith('org.springframework.boot:spring-boot') },
  { technology_id: 'django', technology: 'Django', category: 'framework', ecosystem: 'Python', method: 'manifest_dependency', matches: (name) => name.toLowerCase() === 'django' },
  { technology_id: 'aspnet-core', technology: 'ASP.NET Core', category: 'framework', ecosystem: '.NET', method: 'manifest_dependency', matches: (name) => name.toLowerCase().startsWith('microsoft.aspnetcore.') }
]);

function makeFinding({
  technologyId, technology, category, ecosystem, detectionMethod, evidencePath, evidenceType,
  projectId = null, dependencyName = null, declaredVersion = undefined, versionScope = undefined,
  declaredValue = undefined, condition = null
}) {
  return {
    technology_id: technologyId,
    technology,
    category,
    ecosystem,
    detection_method: detectionMethod,
    evidence_file_path: evidencePath,
    evidence_type: evidenceType,
    ...(projectId ? { project_id: projectId } : {}),
    ...(dependencyName ? { evidence_identity: `package:${dependencyName}` } : {}),
    ...(typeof declaredVersion === 'string' ? { declared_version: declaredVersion } : {}),
    ...(versionScope ? { version_scope: versionScope } : {}),
    ...(typeof declaredValue === 'string' ? { declared_value: declaredValue } : {}),
    ...(condition ? { condition } : {}),
    confidence: 'manifest_declared',
    analyzer_id: 'technologies',
    analyzer_version: '1.0.0',
    explanation: detectionMethod === 'project_target_framework'
      ? 'The project declares this target framework; it does not establish an installed or executing runtime.'
      : detectionMethod === 'framework_reference'
        ? 'The project declares this framework reference; it does not establish runtime installation or execution.'
        : detectionMethod === 'configuration'
          ? 'A local SDK configuration declares this version constraint; it does not establish an installed SDK.'
          : 'A manifest declares this package; the package version is not a framework or runtime version.'
  };
}

export class TechnologyAnalyzer extends Analyzer {
  constructor() {
    super({ id: 'technologies', version: '1.0.0', dependsOn: ['dependencies', 'dotnet'] });
  }

  async analyze(context) {
    const findings = [];
    const seen = new Set();
    const add = (item) => {
      const identity = [item.technology_id, item.evidence_file_path, item.project_id ?? '', item.evidence_type, item.evidence_identity ?? item.declared_value ?? ''].join('\0');
      if (seen.has(identity)) return;
      seen.add(identity);
      findings.push(item);
    };
    const dependencyResults = [
      ...(context.results?.dependencies?.dependencies ?? []),
      ...(context.results?.dotnet?.dependencies ?? [])
    ];
    const manifestFacts = context.results?.dependencies?.manifest_facts ?? [];
    for (const fact of manifestFacts) {
      if (fact.parse_status !== 'parsed') continue;
      for (const rule of TECHNOLOGY_RULES.filter((candidate) => candidate.ecosystem !== '.NET')) {
        if (fact.ecosystem !== rule.ecosystem) continue;
        const dependency = dependencyResults.find((item) => item.manifest_path === fact.manifest_path
          && item.ecosystem === rule.ecosystem && typeof item.name === 'string' && rule.matches(item.name));
        if (!dependency) continue;
        add(makeFinding({
          technologyId: rule.technology_id,
          technology: rule.technology,
          category: rule.category,
          ecosystem: rule.ecosystem,
          detectionMethod: rule.method,
          evidencePath: dependency.manifest_path,
          evidenceType: 'manifest_dependency',
          dependencyName: dependency.name,
          declaredVersion: dependency.declared_version ?? dependency.version,
          versionScope: 'package'
        }));
      }
    }

    for (const dependency of context.results?.dotnet?.dependencies ?? []) {
      const rule = TECHNOLOGY_RULES.find((candidate) => candidate.ecosystem === '.NET' && candidate.matches(dependency.name));
      if (!rule) continue;
      add(makeFinding({
        technologyId: rule.technology_id,
        technology: rule.technology,
        category: rule.category,
        ecosystem: rule.ecosystem,
        detectionMethod: 'manifest_dependency',
        evidencePath: dependency.manifest_path,
        evidenceType: 'package_reference',
        projectId: dependency.project_id,
        dependencyName: dependency.name,
        declaredVersion: dependency.declared_version,
        versionScope: 'package',
        condition: dependency.condition
      }));
    }

    for (const project of context.results?.dotnet?.projects ?? []) {
      for (const framework of project.target_frameworks ?? []) {
        const normalized = framework.declared_value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        add(makeFinding({
          technologyId: `dotnet-target-${normalized}`,
          technology: `.NET target framework ${framework.declared_value}`,
          category: 'project_target_framework',
          ecosystem: '.NET',
          detectionMethod: 'project_target_framework',
          evidencePath: framework.evidence_file_path,
          evidenceType: 'project_property',
          projectId: project.project_id,
          declaredValue: framework.declared_value,
          condition: framework.condition
        }));
      }
      for (const reference of project.framework_references ?? []) {
        if (reference.name.toLowerCase() !== 'microsoft.aspnetcore.app') continue;
        add(makeFinding({
          technologyId: 'aspnet-core',
          technology: 'ASP.NET Core',
          category: 'framework',
          ecosystem: '.NET',
          detectionMethod: 'framework_reference',
          evidencePath: reference.evidence_file_path,
          evidenceType: 'framework_reference',
          projectId: project.project_id,
          dependencyName: reference.name,
          condition: reference.condition
        }));
      }
    }

    for (const sdk of context.results?.dotnet?.sdk_constraints ?? []) {
      add(makeFinding({
        technologyId: 'dotnet-sdk',
        technology: '.NET SDK',
        category: 'sdk_constraint',
        ecosystem: '.NET',
        detectionMethod: 'configuration',
        evidencePath: sdk.evidence_file_path,
        evidenceType: 'sdk_configuration',
        declaredVersion: sdk.declared_version,
        versionScope: 'sdk_constraint'
      }));
    }

    return findings.sort((left, right) => left.technology_id.localeCompare(right.technology_id)
      || left.evidence_file_path.localeCompare(right.evidence_file_path)
      || String(left.project_id).localeCompare(String(right.project_id)));
  }
}
