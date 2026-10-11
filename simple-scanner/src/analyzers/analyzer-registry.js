import { isSemver } from '../utils/semver.js';

const ANALYZER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const EXECUTION_STATES = ['completed', 'failed', 'skipped', 'unsupported', 'cancelled'];

export class Analyzer {
  constructor({ id, version, dependsOn = [] } = {}) {
    this.id = id;
    this.version = version;
    this.dependsOn = dependsOn;
  }

  async analyze() {
    throw new Error('analyze() must be implemented');
  }
}

function safeAnalyzerOutput(value, seen = new Set(), depth = 0) {
  if (depth > 100) throw new TypeError('Analyzer output exceeds the maximum nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Analyzer output is not JSON-safe.');
  if (seen.has(value)) throw new TypeError('Analyzer output contains a cycle.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) safeAnalyzerOutput(child, seen, depth + 1);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Analyzer output must use plain JSON objects.');
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Analyzer output contains a forbidden property.');
      safeAnalyzerOutput(child, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function safeContext(context, results) {
  const { signal, results: _priorResults, ...rest } = context;
  return { ...structuredClone(rest), results: structuredClone(results), signal };
}

function emptyCounts() {
  return { completed: 0, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 };
}

export class AnalyzerRegistry {
  #analyzers = new Map();

  register(analyzer) {
    if (!analyzer || typeof analyzer.id !== 'string' || !ANALYZER_ID.test(analyzer.id)) {
      throw new TypeError('Analyzer identifier must be a lowercase letter followed by lowercase letters, digits, underscores, or hyphens.');
    }
    if (!isSemver(analyzer.version)) {
      throw new TypeError('Analyzer version must be a semantic version.');
    }
    if (typeof analyzer.analyze !== 'function') throw new TypeError('Analyzer requires an analyze(context) method.');
    const dependencies = analyzer.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== 'string' || !ANALYZER_ID.test(id))) {
      throw new TypeError('Analyzer dependencies must be an array of valid analyzer identifiers.');
    }
    if (new Set(dependencies).size !== dependencies.length) throw new TypeError('Analyzer dependencies must not contain duplicates.');
    if (this.#analyzers.has(analyzer.id)) throw new Error(`Analyzer ${analyzer.id} is already registered.`);
    this.#analyzers.set(analyzer.id, analyzer);
    return analyzer;
  }

  get(id) {
    return this.#analyzers.get(id);
  }

  list() {
    return [...this.#analyzers.values()].map(({ id, version, dependsOn = [] }) => ({
      id, version, depends_on: [...dependsOn]
    }));
  }

  async run(context, selectedIds = undefined) {
    if (selectedIds !== undefined && (!Array.isArray(selectedIds)
      || selectedIds.some((id) => typeof id !== 'string' || !ANALYZER_ID.test(id)))) {
      throw new TypeError('Selected analyzer IDs must be an array of valid analyzer identifiers.');
    }
    const registered = [...this.#analyzers.values()];
    const requested = new Set(selectedIds ?? registered.map(({ id }) => id));
    const included = new Set();
    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const cycles = new Set();
    const missingDependencies = new Map();

    const visit = (id) => {
      const analyzer = this.#analyzers.get(id);
      if (!analyzer) return false;
      if (visiting.has(id)) {
        cycles.add(id);
        return false;
      }
      if (visited.has(id)) return !cycles.has(id);
      visiting.add(id);
      included.add(id);
      let prerequisitesAvailable = true;
      for (const dependencyId of analyzer.dependsOn ?? []) {
        if (!this.#analyzers.has(dependencyId)) {
          const missing = missingDependencies.get(id) ?? [];
          missing.push(dependencyId);
          missingDependencies.set(id, missing);
          prerequisitesAvailable = false;
        } else if (!visit(dependencyId)) {
          prerequisitesAvailable = false;
          if (cycles.has(dependencyId)) cycles.add(id);
        }
      }
      visiting.delete(id);
      visited.add(id);
      order.push(id);
      return prerequisitesAvailable && !cycles.has(id);
    };

    const failures = [];
    const executions = new Map(registered.map((analyzer) => [analyzer.id, {
      analyzer_id: analyzer.id,
      version: analyzer.version,
      status: 'skipped',
      selected: requested.has(analyzer.id),
      depends_on: [...(analyzer.dependsOn ?? [])]
    }]));
    for (const requestedId of requested) {
      if (this.#analyzers.has(requestedId)) visit(requestedId);
      else {
        const analyzerId = ANALYZER_ID.test(requestedId) ? requestedId : 'unknown';
        executions.set(`unknown:${executions.size}`, {
          analyzer_id: analyzerId, version: null, status: 'failed', selected: true, depends_on: []
        });
        failures.push({ analyzer_id: analyzerId, code: 'ANALYZER_NOT_FOUND', message: 'A requested analyzer is not registered.' });
      }
    }

    const results = {};
    const outcomeById = new Map();
    const appendFailure = (id, code, message) => failures.push({ analyzer_id: id, code, message });
    for (const id of order) {
      const analyzer = this.#analyzers.get(id);
      const execution = executions.get(id);
      if (context.signal?.aborted) {
        execution.status = 'cancelled';
        outcomeById.set(id, 'cancelled');
        continue;
      }
      const missing = missingDependencies.get(id) ?? [];
      if (cycles.has(id) || missing.length > 0) {
        execution.status = 'skipped';
        outcomeById.set(id, 'skipped');
        appendFailure(id, 'ANALYZER_DEPENDENCY_UNAVAILABLE', 'Analyzer prerequisites are missing or cyclic.');
        continue;
      }
      const unavailableDependency = (analyzer.dependsOn ?? []).find((dependencyId) => outcomeById.get(dependencyId) !== 'completed');
      if (unavailableDependency) {
        execution.status = 'skipped';
        outcomeById.set(id, 'skipped');
        appendFailure(id, 'ANALYZER_DEPENDENCY_UNAVAILABLE', 'An analyzer prerequisite did not complete.');
        continue;
      }
      try {
        if (typeof analyzer.supports === 'function' && !(await analyzer.supports(safeContext(context, results)))) {
          execution.status = 'unsupported';
          outcomeById.set(id, 'unsupported');
          appendFailure(id, 'ANALYZER_UNSUPPORTED', 'The analyzer does not support this scan scope.');
          continue;
        }
        const output = await analyzer.analyze(safeContext(context, results));
        if (output === undefined) throw new TypeError('Analyzer returned no result.');
        safeAnalyzerOutput(output);
        results[id] = structuredClone(output);
        execution.status = 'completed';
        outcomeById.set(id, 'completed');
      } catch {
        execution.status = 'failed';
        outcomeById.set(id, 'failed');
        appendFailure(id, 'ANALYZER_FAILED', `Analyzer ${id} failed.`);
      }
    }

    if (context.signal?.aborted) {
      for (const id of order) {
        const execution = executions.get(id);
        if (execution.status === 'skipped' && !outcomeById.has(id)) execution.status = 'cancelled';
      }
    }

    const executionList = [
      ...registered.map(({ id }) => executions.get(id)),
      ...[...executions.entries()].filter(([id]) => id.startsWith('unknown:')).map(([, execution]) => execution)
    ];
    const counts = emptyCounts();
    for (const execution of executionList) counts[EXECUTION_STATES.includes(execution.status) ? execution.status : 'failed'] += 1;
    return { results, failures, executions: executionList, counts };
  }
}
