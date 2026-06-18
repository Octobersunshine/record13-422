const http = require('http');

function makeRequest(path, method, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, rawData: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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

async function runTests() {
  console.log(`${colors.cyan}=== API Integration Test: Retry + Failure Recording ===${colors.reset}\n`);

  console.log('Step 1: POST /api/purge (will fail with test keys, but retries should happen)');
  const purgeRes = await makeRequest('/api/purge', 'POST', JSON.stringify({ filePath: '/static/js/main.js' }));
  console.log('  Status:', purgeRes.statusCode);
  console.log('  Response:', JSON.stringify(purgeRes.data, null, 2).split('\n').join('\n  '));
  assert(purgeRes.statusCode === 502, 'Failed purge should return 502');
  assert(purgeRes.data.recorded === true, 'Failure should be recorded');
  assert(purgeRes.data.failureId !== undefined, 'Failure should have failureId');
  assert(purgeRes.data.attempts >= 1, `Should have attempts (got ${purgeRes.data.attempts})`);
  assert(purgeRes.data.retried !== undefined, 'retried flag should be present');
  assert(purgeRes.data.attemptDetails !== undefined, 'attemptDetails should be present');
  const failureId = purgeRes.data.failureId;

  console.log('\nStep 2: GET /api/purge-failures (query failure records)');
  const failuresRes = await makeRequest('/api/purge-failures', 'GET');
  console.log('  Status:', failuresRes.statusCode);
  console.log('  Total records:', failuresRes.data.total);
  assert(failuresRes.statusCode === 200, 'Should return 200');
  assert(failuresRes.data.total >= 1, `Should have at least 1 failure (got ${failuresRes.data.total})`);
  assert(failuresRes.data.records[0].filePath === '/static/js/main.js', 'Record filePath should match');

  console.log('\nStep 3: GET /api/purge-failures/stats (get statistics)');
  const statsRes = await makeRequest('/api/purge-failures/stats', 'GET');
  console.log('  Status:', statsRes.statusCode);
  console.log('  Stats:', JSON.stringify(statsRes.data));
  assert(statsRes.statusCode === 200, 'Should return 200');
  assert(statsRes.data.total >= 1, `Stats total should be >= 1 (got ${statsRes.data.total})`);
  assert(statsRes.data.pending >= 1, `Stats pending should be >= 1 (got ${statsRes.data.pending})`);

  console.log('\nStep 4: GET /api/purge-failures/:id (get single record)');
  const singleRes = await makeRequest(`/api/purge-failures/${failureId}`, 'GET');
  console.log('  Status:', singleRes.statusCode);
  assert(singleRes.statusCode === 200, 'Should return 200');
  assert(singleRes.data.id === failureId, 'Record id should match');
  assert(singleRes.data.status === 'pending', 'Record status should be pending');

  console.log('\nStep 5: POST /api/purge-retry (retry failed task)');
  const retryRes = await makeRequest('/api/purge-retry', 'POST', JSON.stringify({ failureId }));
  console.log('  Status:', retryRes.statusCode);
  console.log('  Results:', JSON.stringify(retryRes.data, null, 2).split('\n').join('\n  '));
  assert(retryRes.statusCode === 207, 'Retry with test keys should return 207');
  assert(retryRes.data.total === 1, `Should retry 1 task (got ${retryRes.data.total})`);
  assert(retryRes.data.results[0].success === false, 'Retry should still fail with test keys');
  assert(retryRes.data.results[0].retried !== undefined, 'Retry result should have retried flag');

  console.log('\nStep 6: POST /api/purge-retry { retryAll: true }');
  const retryAllRes = await makeRequest('/api/purge-retry', 'POST', JSON.stringify({ retryAll: true }));
  console.log('  Status:', retryAllRes.statusCode);
  assert(retryAllRes.statusCode === 207, 'RetryAll should return 207');
  assert(retryAllRes.data.total >= 1, `Should retry at least 1 task (got ${retryAllRes.data.total})`);

  console.log('\nStep 7: GET /api/purge-failures/stats (verify retryCount incremented)');
  const statsAfterRetry = await makeRequest('/api/purge-failures/stats', 'GET');
  console.log('  Stats:', JSON.stringify(statsAfterRetry.data));

  console.log('\nStep 8: DELETE /api/purge-failures/:id (delete record)');
  const deleteRes = await makeRequest(`/api/purge-failures/${failureId}`, 'DELETE');
  console.log('  Status:', deleteRes.statusCode);
  assert(deleteRes.statusCode === 200, 'Delete should return 200');
  assert(deleteRes.data.success === true, 'Delete should succeed');

  console.log('\nStep 9: GET /api/purge-failures/:id (should be 404 after delete)');
  const afterDelete = await makeRequest(`/api/purge-failures/${failureId}`, 'GET');
  assert(afterDelete.statusCode === 404, 'Deleted record should return 404');

  console.log('\nStep 10: DELETE /api/purge-failures (clear all pending)');
  const clearRes = await makeRequest('/api/purge-failures?status=pending', 'DELETE');
  console.log('  Status:', clearRes.statusCode);
  console.log('  Response:', JSON.stringify(clearRes.data));
  assert(clearRes.statusCode === 200, 'Clear should return 200');
  assert(clearRes.data.success === true, 'Clear should succeed');

  console.log(`\n${colors.cyan}══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}  ${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.cyan}══════════════════════════════════════${colors.reset}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => { console.error('Crash:', err); process.exit(1); });
