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
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, rawData: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const colors = { green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m' };
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${colors.green}✓${colors.reset} ${msg}`); passed++; }
  else { console.log(`  ${colors.red}✗${colors.reset} ${msg}`); failed++; }
}

async function runTests() {
  console.log(`${colors.cyan}=== API Integration: Native Batch Purge ===${colors.reset}\n`);

  // 清理之前的失败记录
  await makeRequest('/api/purge-failures?status=pending', 'DELETE');
  await makeRequest('/api/purge-failures?status=resolved', 'DELETE');

  console.log('Step 1: POST /api/purge-batch with multiple paths (native batch mode)');
  const res1 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({
    filePaths: ['/static/js/a.js', '/static/js/b.js', '/static/css/c.css', '/images/d.png']
  }));
  console.log('  Status:', res1.statusCode);
  console.log('  Response snippet:', JSON.stringify({
    mode: res1.data.mode,
    total: res1.data.total,
    successCount: res1.data.successCount,
    failCount: res1.data.failCount,
    batchSize: res1.data.batchSize,
    totalBatches: res1.data.totalBatches,
    provider: res1.data.provider
  }));
  assert(res1.statusCode === 207, 'Failed purge should return 207');
  assert(res1.data.mode === 'native-batch', `Mode should be native-batch (got ${res1.data.mode})`);
  assert(res1.data.total === 4, `Total should be 4 (got ${res1.data.total})`);
  assert(res1.data.totalBatches === 1, `1 batch (got ${res1.data.totalBatches}) - aliyun default 1000`);
  assert(res1.data.failCount === 4, `All 4 should fail with test keys (got ${res1.data.failCount})`);
  assert(Array.isArray(res1.data.batchResults) && res1.data.batchResults.length === 1, 'Should have batchResults array');
  if (res1.data.failedPaths) {
    assert(res1.data.failedPaths.length === 4, `failedPaths should have 4 entries (got ${res1.data.failedPaths?.length})`);
    assert(res1.data.failedPaths.every(f => f.failureId), 'Each failed path should have failureId');
  }

  console.log('\nStep 2: Verify failures were recorded individually');
  const stats = await makeRequest('/api/purge-failures/stats', 'GET');
  console.log('  Stats:', JSON.stringify(stats.data));
  assert(stats.data.pending === 4, `Should have 4 pending records (got ${stats.data.pending})`);
  assert(stats.data.total === 4, `Should have 4 total records (got ${stats.data.total})`);

  console.log('\nStep 3: POST /api/purge-batch with duplicates (should dedupe)');
  const res2 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({
    filePaths: ['/dup.js', '/dup.js', '/dup.js', '/unique.js']
  }));
  assert(res2.data.total === 2, `Should dedupe to 2 paths (got ${res2.data.total})`);
  const stats2 = await makeRequest('/api/purge-failures/stats', 'GET');
  const newFailures = stats2.data.total - stats.data.total;
  assert(newFailures === 2, `Should add 2 new failures (got ${newFailures})`);

  console.log('\nStep 4: POST /api/purge-batch with useNativeBatch=false (fallback to per-file)');
  const res3 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({
    filePaths: ['/perfile1.js', '/perfile2.js'],
    useNativeBatch: false
  }));
  console.log('  Mode:', res3.data.mode);
  assert(res3.data.mode === 'per-file', `Mode should be per-file (got ${res3.data.mode})`);
  assert(Array.isArray(res3.data.results) && res3.data.results.length === 2, 'Should have per-file results array');

  console.log('\nStep 5: POST /api/purge-batch with single path (per-file since count = 1)');
  const res4 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({
    filePaths: ['/single.js']
  }));
  assert(res4.data.mode === 'per-file', `Single path should use per-file mode (got ${res4.data.mode})`);

  console.log('\nStep 6: POST /api/purge-batch with missing filePaths');
  const res5 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({}));
  assert(res5.statusCode === 400, `Missing filePaths should return 400 (got ${res5.statusCode})`);

  console.log('\nStep 7: POST /api/purge-batch with empty array');
  const res6 = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({ filePaths: [] }));
  assert(res6.statusCode === 400, `Empty array should return 400 (got ${res6.statusCode})`);

  console.log(`\n${colors.cyan}══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}  ${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.cyan}══════════════════════════════════════${colors.reset}`);

  // 清理
  await makeRequest('/api/purge-failures', 'DELETE');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('Crash:', err); process.exit(1); });
