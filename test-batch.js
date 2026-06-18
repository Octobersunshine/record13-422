require('dotenv').config();
const CdnPurger = require('./cdn-purger');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${colors.green}✓${colors.reset} ${msg}`); passed++; }
  else { console.log(`  ${colors.red}✗${colors.reset} ${msg}`); failed++; }
}

function section(title) {
  console.log(`\n${colors.cyan}=== ${title} ===${colors.reset}\n`);
}

class MockBatchCdnPurger extends CdnPurger {
  constructor(config, scenarioMap) {
    super(config);
    this.scenarioMap = scenarioMap;
    this.callCount = 0;
    this.calls = [];
  }

  async purgeBatch(paths) {
    this.callCount++;
    const key = paths.sort().join(',');
    const scenario = this.scenarioMap[key] || (typeof this.scenarioMap === 'function' ? this.scenarioMap(paths, this.callCount) : { type: 'success' });
    this.calls.push({ call: this.callCount, paths, scenarioType: scenario.type });

    if (scenario.type === 'networkError') {
      const err = { success: false, error: scenario.message, code: scenario.code };
      throw err;
    }

    if (scenario.type === 'httpError') {
      const err = { success: false, statusCode: scenario.statusCode, error: { Message: scenario.message } };
      throw err;
    }

    if (scenario.type === 'success') {
      return { success: true, statusCode: 200, data: { ok: true, paths } };
    }

    throw new Error(scenario.message || 'Unknown error');
  }
}

async function runTests() {
  console.log(`${colors.cyan}╔══════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║   Batch Purge & Multi-File Test Suite                  ║${colors.reset}`);
  console.log(`${colors.cyan}╚══════════════════════════════════════════════════════╝${colors.reset}`);

  section('Test 1: purgeBatch validates input');
  try {
    const p = new CdnPurger({ provider: 'mock', domain: 'x.com' });
    await p.purgeBatch();
    assert(false, 'Should throw for undefined');
  } catch (e) { assert(true, 'Throws for undefined'); }

  try {
    const p = new CdnPurger({ provider: 'mock', domain: 'x.com' });
    await p.purgeBatch([]);
    assert(false, 'Should throw for empty array');
  } catch (e) { assert(true, 'Throws for empty array'); }

  section('Test 2: purgeBatchWithRetry - all in one batch succeeds');
  const p1 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 2, retryBaseDelay: 5 },
    { type: 'success' }
  );
  const paths1 = ['/a.js', '/b.js', '/c.js', '/d.js', '/e.js'];
  try {
    const res = await p1.purgeBatchWithRetry(paths1);
    assert(res.success === true, 'Should succeed');
    assert(res.total === 5, `Total should be 5 (got ${res.total})`);
    assert(res.totalBatches === 1, `Should have 1 batch (got ${res.totalBatches})`);
    assert(res.successCount === 5, `Success count should be 5 (got ${res.successCount})`);
    assert(res.failCount === 0, `Fail count should be 0 (got ${res.failCount})`);
    assert(res.batchResults[0].retried === false, 'Should not retry');
    assert(p1.callCount === 1, `Should call purgeBatch once (got ${p1.callCount})`);
  } catch (e) { assert(false, `Should not throw: ${e.message}`); }

  section('Test 3: purgeBatchWithRetry - splits into multiple batches');
  const p2 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 2, maxRetries: 1, retryBaseDelay: 5 },
    () => ({ type: 'success' })
  );
  const paths2 = ['/1.js', '/2.js', '/3.js', '/4.js', '/5.js'];
  try {
    const res = await p2.purgeBatchWithRetry(paths2);
    assert(res.totalBatches === 3, `Should split into 3 batches (2+2+1, got ${res.totalBatches})`);
    assert(p2.callCount === 3, `Should call purgeBatch 3 times (got ${p2.callCount})`);
    assert(res.batchResults[0].paths.length === 2, 'Batch 1 should have 2 paths');
    assert(res.batchResults[1].paths.length === 2, 'Batch 2 should have 2 paths');
    assert(res.batchResults[2].paths.length === 1, 'Batch 3 should have 1 path');
    assert(res.batchResults[0].batchIndex === 1, 'Batch indices start at 1');
  } catch (e) { assert(false, `Should not throw: ${e.message}`); }

  section('Test 4: purgeBatchWithRetry - first attempt of batch fails, retry succeeds');
  const p3 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 3, retryBaseDelay: 5 },
    (paths, callCount) => {
      if (callCount === 1) return { type: 'networkError', code: 'ECONNRESET', message: 'reset' };
      if (callCount === 2) return { type: 'networkError', code: 'ETIMEDOUT', message: 'timeout' };
      return { type: 'success' };
    }
  );
  try {
    const res = await p3.purgeBatchWithRetry(['/x.js']);
    assert(res.success === true, 'Should succeed after retries');
    assert(res.batchResults[0].retried === true, 'Should mark retried=true');
    assert(res.batchResults[0].attempts.length === 3, `Should have 3 attempts (got ${res.batchResults[0].attempts.length})`);
    assert(res.batchResults[0].finalAttempt === 3, `Final attempt should be 3`);
    assert(res.batchResults[0].attempts[0].errorCode === 'ECONNRESET', 'First attempt code should be ECONNRESET');
    assert(res.batchResults[0].attempts[0].willRetry === true, 'First attempt should plan retry');
  } catch (e) { assert(false, `Should not throw: ${e.message}`); }

  section('Test 5: purgeBatchWithRetry - all retries exhausted for single batch');
  const p4 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 2, retryBaseDelay: 5 },
    () => ({ type: 'networkError', code: 'ECONNRESET', message: 'reset' })
  );
  try {
    await p4.purgeBatchWithRetry(['/y.js']);
    assert(false, 'Should throw');
  } catch (failure) {
    assert(failure.success === false, 'success should be false');
    assert(failure.failCount === 1, `failCount should be 1 (got ${failure.failCount})`);
    assert(failure.failedPaths[0] === '/y.js', 'Should record failedPaths');
    assert(failure.batchResults[0].attempts.length === 3, `Should have 3 total attempts (1+2 retries, got ${failure.batchResults[0].attempts.length})`);
    assert(failure.batchResults[0].attempts[2].willRetry === false, 'Last attempt should mark willRetry=false');
  }

  section('Test 6: purgeBatchWithRetry - partial batch failure (batch 1 fails, batch 2 succeeds)');
  const p5 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 2, maxRetries: 1, retryBaseDelay: 5 },
    (paths, callCount) => {
      if (callCount === 1) return { type: 'networkError', code: 'ECONNRESET', message: 'reset' };
      if (callCount === 2) return { type: 'networkError', code: 'ECONNRESET', message: 'reset' };
      return { type: 'success' };
    }
  );
  try {
    await p5.purgeBatchWithRetry(['/a.js', '/b.js', '/c.js', '/d.js']);
    assert(false, 'Should throw');
  } catch (failure) {
    assert(failure.total === 4, `Total should be 4 (got ${failure.total})`);
    assert(failure.totalBatches === 2, `2 batches (got ${failure.totalBatches})`);
    assert(failure.batchResults[0].success === false, 'Batch 1 should fail');
    assert(failure.batchResults[1].success === true, 'Batch 2 should succeed');
    assert(failure.successCount === 2, `2 successful paths (got ${failure.successCount})`);
    assert(failure.failCount === 2, `2 failed paths (got ${failure.failCount})`);
  }

  section('Test 7: purgeBatchWithRetry - 5xx triggers retry, 4xx does not');
  const p5xx = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 2, retryBaseDelay: 5 },
    (paths, callCount) => {
      if (callCount === 1) return { type: 'httpError', statusCode: 503, message: 'unavailable' };
      if (callCount === 2) return { type: 'httpError', statusCode: 502, message: 'bad gw' };
      return { type: 'success' };
    }
  );
  try {
    const res = await p5xx.purgeBatchWithRetry(['/5xx.js']);
    assert(res.success === true, 'Should succeed after 5xx retries');
    assert(res.batchResults[0].attempts.length === 3, `3 attempts for 5xx (got ${res.batchResults[0].attempts.length})`);
  } catch (e) { assert(false, `Should not throw: ${e.message}`); }

  const p4xx = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 3, retryBaseDelay: 5 },
    () => ({ type: 'httpError', statusCode: 401, message: 'Invalid key' })
  );
  try {
    await p4xx.purgeBatchWithRetry(['/4xx.js']);
    assert(false, 'Should throw');
  } catch (failure) {
    assert(failure.batchResults[0].attempts.length === 1, `Only 1 attempt for 4xx (got ${failure.batchResults[0].attempts.length})`);
  }

  section('Test 8: purgeBatchWithRetry - deduplication of duplicate paths');
  const pdup = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 10, maxRetries: 1, retryBaseDelay: 5 },
    () => ({ type: 'success' })
  );
  try {
    const res = await pdup.purgeBatchWithRetry(['/dup.js', '/dup.js', '/dup.js', '/other.js']);
    assert(res.total === 2, `Should dedup to 2 unique paths (got ${res.total})`);
  } catch (e) { assert(false, e.message); }

  section('Test 9: Provider-specific batchSize defaults');
  const aliyun = new CdnPurger({ provider: 'aliyun', domain: 'x.com' });
  const tencent = new CdnPurger({ provider: 'tencent', domain: 'x.com' });
  const qiniu = new CdnPurger({ provider: 'qiniu', domain: 'x.com' });
  const cf = new CdnPurger({ provider: 'cloudflare', domain: 'x.com' });
  assert(aliyun.batchSize === 1000, `Aliyun default batchSize should be 1000 (got ${aliyun.batchSize})`);
  assert(tencent.batchSize === 100, `Tencent default batchSize should be 100 (got ${tencent.batchSize})`);
  assert(qiniu.batchSize === 100, `Qiniu default batchSize should be 100 (got ${qiniu.batchSize})`);
  assert(cf.batchSize === 30, `Cloudflare default batchSize should be 30 (got ${cf.batchSize})`);

  section('Test 10: batchSize can be overridden via PURGE_BATCH_SIZE env');
  process.env.PURGE_BATCH_SIZE = '42';
  const custom = new CdnPurger({ provider: 'aliyun', domain: 'x.com' });
  assert(custom.batchSize === 42, `Custom batchSize should be 42 (got ${custom.batchSize})`);
  delete process.env.PURGE_BATCH_SIZE;

  section('Test 11: PurgeRecorder correctly records individual failures from batch');
  const PurgeRecorder = require('./purge-recorder');
  const testRecDir = path.join(__dirname, 'test-batch-records');
  if (fs.existsSync(testRecDir)) fs.rmSync(testRecDir, { recursive: true });
  const rec = new PurgeRecorder({ storageDir: testRecDir, maxRecords: 100 });

  const p6 = new MockBatchCdnPurger(
    { provider: 'mock', domain: 'cdn.example.com', batchSize: 2, maxRetries: 1, retryBaseDelay: 5 },
    (paths, callCount) => {
      if (paths.includes('/bad1.js') || paths.includes('/bad2.js')) {
        return { type: 'networkError', code: 'ETIMEDOUT', message: 'timeout' };
      }
      return { type: 'success' };
    }
  );
  const mixedPaths = ['/bad1.js', '/bad2.js', '/good.js', '/alsogood.js'];
  try {
    await p6.purgeBatchWithRetry(mixedPaths);
  } catch (failure) {
    failure.successPaths.forEach((p) => {
      rec.recordSuccess(p, `https://cdn.example.com${p}`, 'mock');
    });
    failure.failedPaths.forEach((p) => {
      const failedBatch = failure.batchResults.find(b => !b.success && b.paths.includes(p));
      rec.record({
        success: false,
        filePath: p,
        fullUrl: `https://cdn.example.com${p}`,
        provider: 'mock',
        attempts: failedBatch ? failedBatch.attempts : [],
        finalAttempt: failedBatch ? failedBatch.finalAttempt : 1,
        error: failedBatch?.error || { code: 'BATCH_FAILED', message: 'batch fail' },
        timestamp: failure.timestamp
      });
    });
  }
  const stats = rec.getStats();
  assert(stats.total === 2, `Should record 2 failures (got ${stats.total})`);
  assert(stats.pending === 2, `Should have 2 pending (got ${stats.pending})`);
  fs.rmSync(testRecDir, { recursive: true });

  console.log(`\n${colors.cyan}════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}  ${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.cyan}════════════════════════════════════════════════════════${colors.reset}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('Crash:', err); process.exit(1); });
