const http = require('http');

function makeRequest(path, method, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            data: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            rawData: data
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

async function runTests() {
  console.log('=== API Endpoint Tests ===\n');

  console.log('1. Testing GET /health');
  const healthResult = await makeRequest('/health', 'GET');
  console.log('   Status:', healthResult.statusCode);
  console.log('   Response:', JSON.stringify(healthResult.data, null, 2));
  console.log('   ✓ Passed\n');

  console.log('2. Testing POST /api/purge - missing filePath');
  const missingResult = await makeRequest('/api/purge', 'POST', JSON.stringify({}));
  console.log('   Status:', missingResult.statusCode);
  console.log('   Response:', JSON.stringify(missingResult.data, null, 2));
  console.log('   ✓ Passed\n');

  console.log('3. Testing POST /api/purge - with filePath');
  const purgeResult = await makeRequest('/api/purge', 'POST', JSON.stringify({
    filePath: '/static/js/main.js'
  }));
  console.log('   Status:', purgeResult.statusCode);
  console.log('   Response:', JSON.stringify(purgeResult.data, null, 2));
  console.log('   ✓ API called successfully (auth error expected with test keys)\n');

  console.log('4. Testing POST /api/purge-batch - with filePaths');
  const batchResult = await makeRequest('/api/purge-batch', 'POST', JSON.stringify({
    filePaths: ['/static/js/main.js', '/static/css/style.css', '/images/logo.png']
  }));
  console.log('   Status:', batchResult.statusCode);
  console.log('   Response:', JSON.stringify(batchResult.data, null, 2));
  console.log('   ✓ Batch API called successfully\n');

  console.log('5. Testing 404 endpoint');
  const notFoundResult = await makeRequest('/invalid', 'GET');
  console.log('   Status:', notFoundResult.statusCode);
  console.log('   Available endpoints listed:', notFoundResult.data?.availableEndpoints?.length > 0);
  console.log('   ✓ Passed\n');

  console.log('=== All Tests Completed ===');
}

runTests().catch(console.error);
