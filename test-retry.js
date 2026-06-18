require('dotenv').config();
const CdnPurger = require('./cdn-purger');
const PurgeRecorder = require('./purge-recorder');
const fs = require('fs');
const path = require('path');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ${colors.green}✓${colors.reset} ${message}`);
    passed++;
  } else {
    console.log(`  ${colors.red}✗${colors.reset} ${message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${colors.cyan}=== ${title} ===${colors.reset}\n`);
}

class MockCdnPurger extends CdnPurger {
  constructor(config, scenario) {
    super(config);
    this.scenario = scenario;
    this.callCount = 0;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : 3;
    this.retryBaseDelay = config.retryBaseDelay !== undefined ? config.retryBaseDelay : 10;
    this.retryBackoffFactor = config.retryBackoffFactor !== undefined ? config.retryBackoffFactor : 2;
  }

  async purge(filePath) {
    this.callCount++;
    const action = this.scenario[this.callCount - 1];

    if (action === undefined) {
      return { success: true, statusCode: 200, data: { ok: true } };
    }

    if (action.type === 'networkError') {
      const err = { success: false, error: action.message, code: action.code };
      throw err;
    }

    if (action.type === 'httpError') {
      const err = { success: false, statusCode: action.statusCode, error: { Message: action.message } };
      throw err;
    }

    if (action.type === 'success') {
      return { success: true, statusCode: 200, data: { ok: true } };
    }

    if (action.type === 'throw') {
      throw new Error(action.message);
    }
  }
}

async function runTests() {
  console.log(`${colors.cyan}╔══════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║   Retry Mechanism & Failure Recording Test Suite      ║${colors.reset}`);
  console.log(`${colors.cyan}╚══════════════════════════════════════════════════════╝${colors.reset}`);

  section('Test 1: Network error triggers retry and eventually succeeds');

  const purger1 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 3,
    retryBaseDelay: 10,
    retryBackoffFactor: 2
  }, [
    { type: 'networkError', code: 'ECONNRESET', message: 'socket hang up' },
    { type: 'networkError', code: 'ETIMEDOUT', message: 'connection timed out' },
    { type: 'success' }
  ]);

  try {
    const result = await purger1.purgeWithRetry('/static/js/main.js');
    assert(result.success === true, 'Should succeed after retries');
    assert(result.retried === true, 'retried flag should be true');
    assert(result.attempts.length === 3, `Should have 3 attempts (got ${result.attempts.length})`);
    assert(result.finalAttempt === 3, `Final attempt should be 3 (got ${result.finalAttempt})`);
    assert(result.attempts[0].success === false, 'First attempt should fail');
    assert(result.attempts[1].success === false, 'Second attempt should fail');
    assert(result.attempts[2].success === true, 'Third attempt should succeed');
    assert(result.attempts[0].errorCode === 'ECONNRESET', 'First error code should be ECONNRESET');
    assert(result.attempts[1].errorCode === 'ETIMEDOUT', 'Second error code should be ETIMEDOUT');
    assert(result.attempts[0].willRetry === true, 'First attempt should mark willRetry=true');
  } catch (e) {
    assert(false, `Should not throw: ${e.message}`);
  }

  section('Test 2: All retries exhausted, failure recorded');

  const purger2 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 3,
    retryBaseDelay: 10,
    retryBackoffFactor: 2
  }, [
    { type: 'networkError', code: 'ECONNRESET', message: 'socket hang up' },
    { type: 'networkError', code: 'ECONNRESET', message: 'socket hang up' },
    { type: 'networkError', code: 'ECONNRESET', message: 'socket hang up' },
    { type: 'networkError', code: 'ECONNRESET', message: 'socket hang up' }
  ]);

  let failure2 = null;
  try {
    await purger2.purgeWithRetry('/static/css/style.css');
    assert(false, 'Should have thrown');
  } catch (failure) {
    failure2 = failure;
    assert(failure.success === false, 'Failure should have success=false');
    assert(failure.filePath === '/static/css/style.css', 'Failure should record filePath');
    assert(failure.fullUrl === 'https://cdn.example.com/static/css/style.css', 'Failure should record fullUrl');
    assert(failure.attempts.length === 4, `Should have 4 attempts (got ${failure.attempts.length})`);
    assert(failure.finalAttempt === 4, `Final attempt should be 4 (got ${failure.finalAttempt})`);
    assert(failure.error.code === 'ECONNRESET', `Error code should be ECONNRESET (got ${failure.error.code})`);
    assert(failure.timestamp !== undefined, 'Failure should have timestamp');
    assert(failure.attempts[3].willRetry === false, 'Last attempt should mark willRetry=false');
  }

  section('Test 3: 4xx client error does NOT trigger retry');

  const purger3 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 3,
    retryBaseDelay: 10
  }, [
    { type: 'httpError', statusCode: 401, message: 'Invalid access key' }
  ]);

  try {
    await purger3.purgeWithRetry('/static/img/logo.png');
    assert(false, 'Should have thrown');
  } catch (failure) {
    assert(failure.attempts.length === 1, `Should have 1 attempt only for 4xx (got ${failure.attempts.length})`);
    assert(failure.attempts[0].willRetry === false, '4xx should not retry');
    assert(purger3.callCount === 1, `Should only call purge once (got ${purger3.callCount})`);
  }

  section('Test 4: 5xx server error triggers retry');

  const purger4 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 3,
    retryBaseDelay: 10
  }, [
    { type: 'httpError', statusCode: 503, message: 'Service unavailable' },
    { type: 'httpError', statusCode: 502, message: 'Bad gateway' },
    { type: 'success' }
  ]);

  try {
    const result = await purger4.purgeWithRetry('/static/img/banner.jpg');
    assert(result.success === true, 'Should succeed after 5xx retries');
    assert(result.attempts.length === 3, `Should have 3 attempts (got ${result.attempts.length})`);
    assert(result.attempts[0].statusCode === 503, 'First attempt status should be 503');
    assert(result.attempts[1].statusCode === 502, 'Second attempt status should be 502');
    assert(result.attempts[0].willRetry === true, '5xx should trigger retry');
  } catch (e) {
    assert(false, `Should not throw: ${e.message}`);
  }

  section('Test 5: 429 rate limit triggers retry');

  const purger5 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 2,
    retryBaseDelay: 10
  }, [
    { type: 'httpError', statusCode: 429, message: 'Too many requests' },
    { type: 'success' }
  ]);

  try {
    const result = await purger5.purgeWithRetry('/static/img/avatar.png');
    assert(result.success === true, 'Should succeed after 429 retry');
    assert(result.attempts.length === 2, `Should have 2 attempts (got ${result.attempts.length})`);
    assert(result.attempts[0].statusCode === 429, 'First attempt status should be 429');
  } catch (e) {
    assert(false, `Should not throw: ${e.message}`);
  }

  section('Test 6: Exponential backoff calculation');

  const purger6 = new MockCdnPurger({
    provider: 'mock',
    domain: 'cdn.example.com',
    maxRetries: 5,
    retryBaseDelay: 1000,
    retryBackoffFactor: 2
  }, []);

  const base1 = purger6.calculateBackoff(1);
  const base2 = purger6.calculateBackoff(2);
  const base3 = purger6.calculateBackoff(3);

  assert(base1 >= 1000 && base1 < 1300, `Backoff attempt 1 should be ~1000ms (got ${base1}ms)`);
  assert(base2 >= 2000 && base2 < 2300, `Backoff attempt 2 should be ~2000ms (got ${base2}ms)`);
  assert(base3 >= 4000 && base3 < 4300, `Backoff attempt 3 should be ~4000ms (got ${base3}ms)`);

  section('Test 7: PurgeRecorder - record and retrieve failures');

  const testRecordDir = path.join(__dirname, 'test-records');
  if (fs.existsSync(testRecordDir)) {
    fs.rmSync(testRecordDir, { recursive: true });
  }

  const recorder = new PurgeRecorder({ storageDir: testRecordDir, maxRecords: 100 });

  const sampleFailure = {
    success: false,
    filePath: '/static/js/app.js',
    fullUrl: 'https://cdn.example.com/static/js/app.js',
    provider: 'aliyun',
    attempts: [
      { attempt: 1, success: false, errorCode: 'ECONNRESET', willRetry: true },
      { attempt: 2, success: false, errorCode: 'ECONNRESET', willRetry: true },
      { attempt: 3, success: false, errorCode: 'ECONNRESET', willRetry: true },
      { attempt: 4, success: false, errorCode: 'ECONNRESET', willRetry: false }
    ],
    finalAttempt: 4,
    error: { code: 'ECONNRESET', message: 'socket hang up' },
    timestamp: new Date().toISOString()
  };

  const recorded = recorder.record(sampleFailure);
  assert(recorded.id !== undefined, 'Recorded failure should have an id');
  assert(recorded.status === 'pending', 'Recorded failure status should be pending');
  assert(recorded.createdAt !== undefined, 'Recorded failure should have createdAt');
  assert(recorded.history.length === 1, 'Recorded failure should have 1 history entry');

  const allFailures = recorder.getAll();
  assert(allFailures.total === 1, `Should have 1 failure record (got ${allFailures.total})`);
  assert(allFailures.records[0].filePath === '/static/js/app.js', 'Record filePath should match');

  const stats = recorder.getStats();
  assert(stats.total === 1, `Stats total should be 1 (got ${stats.total})`);
  assert(stats.pending === 1, `Stats pending should be 1 (got ${stats.pending})`);

  section('Test 8: PurgeRecorder - mark success resolves failure');

  recorder.recordSuccess('/static/js/app.js', 'https://cdn.example.com/static/js/app.js', 'aliyun');
  const updatedStats = recorder.getStats();
  assert(updatedStats.resolved === 1, `Stats resolved should be 1 (got ${updatedStats.resolved})`);
  assert(updatedStats.pending === 0, `Stats pending should be 0 (got ${updatedStats.pending})`);

  const resolvedRecord = recorder.getById(recorded.id);
  assert(resolvedRecord.status === 'resolved', 'Record status should be resolved');

  section('Test 9: PurgeRecorder - deduplication on same filePath');

  const dupFailure = { ...sampleFailure, timestamp: new Date().toISOString() };
  const reRecorded = recorder.record(dupFailure);
  assert(reRecorded.id === recorded.id, 'Same filePath should reuse existing record id');
  assert(reRecorded.history.length === 3, `History should have 3 entries: initial + resolved + new (got ${reRecorded.history.length})`);
  assert(reRecorded.retryCount === 0, 'retryCount should still be 0 (not retried via API yet)');

  const dedupStats = recorder.getStats();
  assert(dedupStats.total === 1, `Should still have 1 unique record (got ${dedupStats.total})`);

  section('Test 10: PurgeRecorder - persistence across restarts');

  const recorder2 = new PurgeRecorder({ storageDir: testRecordDir });
  const reloadedFailures = recorder2.getAll();
  assert(reloadedFailures.total === 1, `Reloaded recorder should have 1 record (got ${reloadedFailures.total})`);
  assert(reloadedFailures.records[0].filePath === '/static/js/app.js', 'Reloaded record filePath should match');

  section('Test 11: PurgeRecorder - increment retry count');

  recorder2.incrementRetryCount(recorded.id);
  const afterRetry = recorder2.getById(recorded.id);
  assert(afterRetry.retryCount === 1, `retryCount should be 1 (got ${afterRetry.retryCount})`);

  section('Test 12: PurgeRecorder - delete and clear');

  const removed = recorder2.remove(recorded.id);
  assert(removed !== null, 'Remove should return the removed record');
  assert(recorder2.getById(recorded.id) === null, 'Record should be gone after remove');

  recorder2.record(sampleFailure);
  recorder2.record({ ...sampleFailure, filePath: '/other.js', fullUrl: 'https://cdn.example.com/other.js' });
  const clearResult = recorder2.clear({ status: 'pending' });
  assert(clearResult.removed === 2, `Clear should remove 2 pending records (got ${clearResult.removed})`);
  assert(recorder2.getStats().total === 0, 'All records should be cleared');

  section('Test 13: PurgeRecorder - pending filter and getPending');

  recorder2.record(sampleFailure);
  recorder2.record({ ...sampleFailure, filePath: '/resolved.js', fullUrl: 'https://cdn.example.com/resolved.js' });
  recorder2.recordSuccess('/resolved.js', 'https://cdn.example.com/resolved.js', 'aliyun');

  const pendingOnly = recorder2.getAll({ status: 'pending' });
  assert(pendingOnly.total === 1, `Pending filter should return 1 (got ${pendingOnly.total})`);
  assert(pendingOnly.records[0].filePath === '/static/js/app.js', 'Pending record should be app.js');

  const pendingList = recorder2.getPending();
  assert(pendingList.length === 1, `getPending should return 1 record (got ${pendingList.length})`);

  fs.rmSync(testRecordDir, { recursive: true });

  section('Test 14: normalizeError handles various error shapes');

  const purger14 = new MockCdnPurger({ provider: 'mock', domain: 'cdn.example.com' }, []);

  const e1 = purger14.normalizeError({ code: 'ECONNRESET', message: 'reset' });
  assert(e1.isNetworkError === true, 'ECONNRESET should be network error');
  assert(e1.code === 'ECONNRESET', 'Code should be preserved');

  const e2 = purger14.normalizeError({ statusCode: 503, error: { Message: 'unavailable' } });
  assert(e2.isNetworkError === false, '503 should not be network error');
  assert(e2.statusCode === 503, 'StatusCode should be preserved');
  assert(e2.message === 'unavailable', 'Message should be extracted from error.Message');

  const e3 = purger14.normalizeError(new Error('ETIMEDOUT occurred'));
  assert(e3.isNetworkError === true, 'Error message containing ETIMEDOUT should be network error');

  const e4 = purger14.normalizeError({ message: 'something broke' });
  assert(e4.code === 'UNKNOWN', 'Non-retryable error should have UNKNOWN code');
  assert(e4.isNetworkError === false, 'Non-retryable error should not be network error');

  console.log(`\n${colors.cyan}════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}  ${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.cyan}════════════════════════════════════════════════════════${colors.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
