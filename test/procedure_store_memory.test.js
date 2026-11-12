const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  saveProcedure,
  loadProcedure,
  listProcedures,
  deleteProcedure
} = require('../src/procedures/store');
const {
  updateProcedureStats,
  selectBestProcedure,
  ProcedureMemory
} = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');

/**
 * Helper to build a valid sample procedure
 * @param {string} id Unique identifier
 * @param {object} [overrides={}] Override properties
 * @returns {object} Valid procedure object
 */
function createSampleProcedure(id, overrides = {}) {
  return createProcedureTemplate({
    id,
    name: `Test Procedure ${id}`,
    version: 1,
    status: overrides.status || 'experimental',
    steps: [
      { id: 's1', action: 'find_block', parameters: { block: 'oak_log' } }
    ],
    metadata: {
      tags: overrides.tags || ['mining', 'wood'],
      confidenceScore: overrides.confidenceScore !== undefined ? overrides.confidenceScore : 0.5,
      executionCount: overrides.executionCount || 0,
      successCount: overrides.successCount || 0,
      failureCount: overrides.failureCount || 0
    },
    ...overrides
  });
}

test('Procedure Store: Save, Load, List, and Delete procedures', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-proc-store-'));

  try {
    const proc1 = createSampleProcedure('proc_one');
    const proc2 = createSampleProcedure('proc_two');

    const saveRes1 = await saveProcedure(proc1, tempDir);
    assert.equal(saveRes1.success, true);
    assert.equal(saveRes1.data.id, 'proc_one');

    const saveRes2 = await saveProcedure(proc2, tempDir);
    assert.equal(saveRes2.success, true);

    const loadRes1 = await loadProcedure('proc_one', tempDir);
    assert.equal(loadRes1.success, true);
    assert.equal(loadRes1.data.procedure.id, 'proc_one');
    assert.equal(loadRes1.data.procedure.name, 'Test Procedure proc_one');

    const missingRes = await loadProcedure('non_existent', tempDir);
    assert.equal(missingRes.success, false);
    assert.equal(missingRes.reason, 'not_found');

    const listRes = await listProcedures(tempDir);
    assert.equal(listRes.success, true);
    assert.equal(listRes.data.count, 2);

    const delRes = await deleteProcedure('proc_one', tempDir);
    assert.equal(delRes.success, true);

    const listAfter = await listProcedures(tempDir);
    assert.equal(listAfter.data.count, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Procedure Store: Rejects saving invalid procedure schema', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-proc-store-inv-'));

  try {
    const invalidProc = { id: 'bad id with spaces!' };
    const res = await saveProcedure(invalidProc, tempDir);
    assert.equal(res.success, false);
    assert.equal(res.reason, 'invalid_schema');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Procedure Memory: Lifecycle updates and status promotion/demotion', () => {
  let proc = createSampleProcedure('learn_cycle', {
    status: 'experimental',
    executionCount: 0,
    successCount: 0,
    failureCount: 0
  });

  proc = updateProcedureStats(proc, true);
  assert.equal(proc.metadata.executionCount, 1);
  assert.equal(proc.metadata.successCount, 1);
  assert.equal(proc.metadata.confidenceScore, 1.0);
  assert.equal(proc.status, 'experimental');

  proc = updateProcedureStats(proc, true);
  assert.equal(proc.metadata.executionCount, 2);
  assert.equal(proc.status, 'experimental');

  proc = updateProcedureStats(proc, true);
  assert.equal(proc.metadata.executionCount, 3);
  assert.equal(proc.metadata.confidenceScore, 1.0);
  assert.equal(proc.status, 'validated');

  proc = updateProcedureStats(proc, false);
  proc = updateProcedureStats(proc, false);
  assert.equal(proc.metadata.executionCount, 5);
  assert.equal(proc.metadata.successCount, 3);
  assert.equal(proc.metadata.confidenceScore, 0.6);
  assert.equal(proc.status, 'validated');

  proc = updateProcedureStats(proc, false);
  proc = updateProcedureStats(proc, false);
  assert.equal(proc.metadata.executionCount, 7);
  assert.equal(proc.metadata.confidenceScore, 0.429);
  assert.equal(proc.status, 'deprecated');
});

test('Procedure Memory: Procedure selection ranking', () => {
  const procA = createSampleProcedure('proc_a', {
    status: 'experimental',
    confidenceScore: 0.9,
    tags: ['crafting', 'wood']
  });

  const procB = createSampleProcedure('proc_b', {
    status: 'validated',
    confidenceScore: 0.8,
    tags: ['crafting', 'wood']
  });

  const procC = createSampleProcedure('proc_c', {
    status: 'validated',
    confidenceScore: 0.95,
    tags: ['crafting', 'stone']
  });

  const bestForWood = selectBestProcedure([procA, procB, procC], { tags: ['crafting', 'wood'] });
  assert.equal(bestForWood.id, 'proc_b');

  const bestForStone = selectBestProcedure([procA, procB, procC], { tags: ['stone'] });
  assert.equal(bestForStone.id, 'proc_c');
});

test('Procedure Memory: Cache management and persistent synchronization', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-proc-mem-'));

  try {
    const memory = new ProcedureMemory({ storageDir: tempDir });
    const proc = createSampleProcedure('cached_proc', { status: 'experimental' });

    memory.register(proc);
    assert.equal(memory.get('cached_proc').id, 'cached_proc');

    await memory.recordExecution('cached_proc', true);
    await memory.recordExecution('cached_proc', true);
    await memory.recordExecution('cached_proc', true);

    assert.equal(memory.get('cached_proc').status, 'validated');

    const freshMemory = new ProcedureMemory({ storageDir: tempDir });
    const loadedCount = await freshMemory.loadAll();
    assert.equal(loadedCount, 1);
    assert.equal(freshMemory.get('cached_proc').status, 'validated');
    assert.equal(freshMemory.get('cached_proc').metadata.executionCount, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
