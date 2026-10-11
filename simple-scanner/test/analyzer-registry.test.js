import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, AnalyzerRegistry } from '../src/analyzers/analyzer-registry.js';

test('registry preserves successful analyzer results when another analyzer fails', async () => {
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'good', version: '1.0.0', analyze: async () => ({ count: 7 }) });
  registry.register({ id: 'broken', version: '1.0.0', analyze: async () => { throw new Error('contains SECRET_VALUE=hidden'); } });
  const execution = await registry.run({ runId: 'one' });
  assert.deepEqual(execution.results.good, { count: 7 });
  assert.equal(execution.results.broken, undefined);
  assert.deepEqual(execution.failures, [{ analyzer_id: 'broken', code: 'ANALYZER_FAILED', message: 'Analyzer broken failed.' }]);
});

test('registry prevents duplicate IDs and base analyzer signals an unimplemented contract', async () => {
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'same', version: '1.0.0', analyze: async () => ({}) });
  assert.throws(() => registry.register({ id: 'same', version: '2.0.0', analyze: async () => ({}) }), /already registered/);
  await assert.rejects(new Analyzer({ id: 'abstract', version: '1' }).analyze({}), /must be implemented/);
});

test('registry validates analyzer identifiers and semantic versions', () => {
  const registry = new AnalyzerRegistry();
  assert.throws(() => registry.register({ id: 'Bad ID', version: '1.0.0', analyze: async () => ({}) }), /identifier/);
  assert.throws(() => registry.register({ id: 'good', version: 'latest', analyze: async () => ({}) }), /version/);
  assert.throws(() => registry.register({ id: 'good', version: '01.2.3', analyze: async () => ({}) }), /version/);
  assert.throws(() => registry.register({ id: 'good', version: '1.2.3-01', analyze: async () => ({}) }), /version/);
  assert.throws(() => registry.register({ id: 'good', version: '1.0.0', dependsOn: 'base', analyze: async () => ({}) }), /dependencies/);
});

test('registry orders declared prerequisites and records analyzer versions and outcomes', async () => {
  const order = [];
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'consumer', version: '1.2.3', dependsOn: ['provider'], analyze: async ({ results }) => {
    order.push('consumer');
    return { count: results.provider.count + 1 };
  } });
  registry.register({ id: 'provider', version: '2.3.4', analyze: async () => {
    order.push('provider');
    return { count: 4 };
  } });

  const execution = await registry.run({});
  assert.deepEqual(order, ['provider', 'consumer']);
  assert.deepEqual(execution.results.consumer, { count: 5 });
  assert.deepEqual(execution.executions.map(({ analyzer_id, version, status }) => [analyzer_id, version, status]), [
    ['consumer', '1.2.3', 'completed'], ['provider', '2.3.4', 'completed']
  ]);
  assert.deepEqual(execution.counts, { completed: 2, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 });
});

test('registry skips dependents when a prerequisite is missing or fails', async () => {
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'broken', version: '1.0.0', analyze: async () => { throw new Error('PRIVATE_EXCEPTION_TEXT'); } });
  registry.register({ id: 'consumer', version: '1.0.0', dependsOn: ['broken'], analyze: async () => ({ ran: true }) });
  registry.register({ id: 'orphan', version: '1.0.0', dependsOn: ['missing'], analyze: async () => ({ ran: true }) });
  const execution = await registry.run({});
  assert.deepEqual(execution.executions.map(({ analyzer_id, status }) => [analyzer_id, status]), [
    ['broken', 'failed'], ['consumer', 'skipped'], ['orphan', 'skipped']
  ]);
  assert.equal(execution.results.consumer, undefined);
  assert.equal(execution.results.orphan, undefined);
  assert.equal(JSON.stringify(execution).includes('PRIVATE_EXCEPTION_TEXT'), false);
});

test('registry marks unsupported and cancelled analyzers explicitly', async () => {
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'unsupported', version: '1.0.0', supports: () => false, analyze: async () => ({}) });
  registry.register({ id: 'later', version: '1.0.0', analyze: async () => ({}) });
  const noSupport = await registry.run({});
  assert.deepEqual(noSupport.executions.map(({ analyzer_id, status }) => [analyzer_id, status]), [
    ['unsupported', 'unsupported'], ['later', 'completed']
  ]);
  const controller = new AbortController();
  controller.abort();
  const execution = await registry.run({ signal: controller.signal });
  assert.deepEqual(execution.executions.map(({ analyzer_id, status }) => [analyzer_id, status]), [
    ['unsupported', 'cancelled'], ['later', 'cancelled']
  ]);

  const supported = await new AnalyzerRegistry().run({});
  assert.deepEqual(supported.executions, []);
});

test('registry rejects non-JSON analyzer output and isolates mutable results', async () => {
  const registry = new AnalyzerRegistry();
  registry.register({ id: 'first', version: '1.0.0', analyze: async () => ({ nested: { value: 1 } }) });
  registry.register({ id: 'mutator', version: '1.0.0', analyze: async ({ results }) => {
    results.first.nested.value = 99;
    return { value: results.first.nested.value };
  } });
  registry.register({ id: 'invalid', version: '1.0.0', analyze: async () => ({ value: 1n }) });
  const execution = await registry.run({});
  assert.equal(execution.results.first.nested.value, 1);
  assert.equal(execution.results.mutator.value, 99);
  assert.equal(execution.executions.find((item) => item.analyzer_id === 'invalid').status, 'failed');
  assert.equal(execution.failures.some((item) => item.analyzer_id === 'invalid'), true);
});
