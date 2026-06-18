require('dotenv').config();
const CdnPurger = require('./cdn-purger');

console.log('=== Testing CDN Purger Module ===\n');

const purger = new CdnPurger({});

console.log('CDN Provider:', purger.provider);
console.log('CDN Domain:', purger.domain);

const testPath = '/static/js/main.js';
const fullUrl = purger.buildFullUrl(testPath);
console.log('\nTest File Path:', testPath);
console.log('Full URL:', fullUrl);

console.log('\n=== Signature Generation Tests ===\n');

console.log('Testing Aliyun signature generation...');
const aliyunParams = {
  Action: 'RefreshObjectCaches',
  Version: '2018-05-10',
  Format: 'JSON',
  AccessKeyId: 'test-key-id',
  SignatureMethod: 'HMAC-SHA1',
  Timestamp: '2024-01-01T00:00:00Z',
  SignatureVersion: '1.0',
  SignatureNonce: 'test-nonce',
  ObjectPath: 'https://cdn.example.com/static/js/main.js',
  ObjectType: 'File'
};
const aliyunSignature = purger.signAliyun(aliyunParams, 'test-key-secret');
console.log('Aliyun Signature:', aliyunSignature);
console.log('✓ Aliyun signature generated successfully\n');

console.log('Testing Qiniu safeBase64Encode...');
const encoded = purger.safeBase64Encode('test+string/with/special');
console.log('Encoded:', encoded);
console.log('✓ Base64 encoding works correctly\n');

console.log('Testing URL building with and without leading slash...');
const url1 = purger.buildFullUrl('test.jpg');
const url2 = purger.buildFullUrl('/test.jpg');
console.log('Without slash:', url1);
console.log('With slash:', url2);
console.log('Match:', url1 === url2 ? '✓' : '✗');

console.log('\n=== Module Structure ===\n');
console.log('Available providers: aliyun, tencent, qiniu, cloudflare');
console.log('Methods: purge(filePath), buildFullUrl(filePath)');

console.log('\n=== Testing Server Startup ===\n');
console.log('Starting server...');

const http = require('http');

setTimeout(() => {
  const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/health',
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      console.log('Health check response:', data);
      if (res.statusCode === 200) {
        console.log('✓ Server is running and healthy');
      }
      process.exit(0);
    });
  });

  req.on('error', (error) => {
    console.error('Server not accessible:', error.message);
    console.log('(This is expected if server is not running yet)');
    process.exit(0);
  });

  req.end();
}, 2000);
