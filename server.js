require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const CdnPurger = require('./cdn-purger');
const PurgeRecorder = require('./purge-recorder');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const recorder = new PurgeRecorder();

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method;
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  setCorsHeaders(res);

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === '/health' && method === 'GET') {
    sendResponse(res, 200, { status: 'ok', timestamp: Date.now() });
    return;
  }

  if (path === '/api/purge' && method === 'POST') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const filePath = data.filePath || data.path;

        if (!filePath) {
          sendResponse(res, 400, {
            success: false,
            error: 'filePath is required'
          });
          return;
        }

        const purger = new CdnPurger({});

        try {
          const result = await purger.purgeWithRetry(filePath);

          recorder.recordSuccess(filePath, purger.buildFullUrl(filePath), purger.provider);

          sendResponse(res, 200, {
            success: true,
            filePath: filePath,
            fullUrl: result.fullUrl,
            provider: purger.provider,
            retried: result.retried,
            attempts: result.attempts.length,
            attemptDetails: result.attempts,
            result: {
              statusCode: result.statusCode,
              data: result.data
            }
          });
        } catch (failure) {
          const recorded = recorder.record(failure);

          sendResponse(res, 502, {
            success: false,
            filePath: filePath,
            fullUrl: failure.fullUrl,
            provider: failure.provider,
            retried: failure.finalAttempt > 1,
            attempts: failure.attempts.length,
            attemptDetails: failure.attempts,
            error: failure.error?.message || 'Purge failed',
            errorCode: failure.error?.code,
            failureId: recorded.id,
            recorded: true,
            timestamp: failure.timestamp
          });
        }
      } catch (error) {
        console.error('Purge error:', error);
        const errorMessage = error.error?.Message || error.error?.message || error.message || JSON.stringify(error.error || error);
        sendResponse(res, 500, {
          success: false,
          error: errorMessage
        });
      }
    });
    return;
  }

  if (path === '/api/purge-batch' && method === 'POST') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const filePaths = data.filePaths || data.paths;
        const useNativeBatch = data.useNativeBatch !== false;

        if (!Array.isArray(filePaths) || filePaths.length === 0) {
          sendResponse(res, 400, {
            success: false,
            error: 'filePaths array is required'
          });
          return;
        }

        const deduped = [...new Set(filePaths)];
        const purger = new CdnPurger({});

        if (useNativeBatch && deduped.length > 1) {
          try {
            const batchResult = await purger.purgeBatchWithRetry(deduped);

            batchResult.successPaths.forEach((p) => {
              recorder.recordSuccess(p, purger.buildFullUrl(p), purger.provider);
            });

            sendResponse(res, 200, {
              success: true,
              mode: 'native-batch',
              total: batchResult.total,
              successCount: batchResult.successCount,
              failCount: batchResult.failCount,
              batchSize: batchResult.batchSize,
              totalBatches: batchResult.totalBatches,
              totalDuration: batchResult.totalDuration,
              provider: purger.provider,
              batchResults: batchResult.batchResults.map((b) => ({
                batchIndex: b.batchIndex,
                totalBatches: b.totalBatches,
                count: b.count,
                success: b.success,
                retried: b.retried,
                attempts: b.attempts.length,
                duration: b.duration,
                paths: b.paths,
                result: b.result,
                error: b.error
              })),
              successPaths: batchResult.successPaths,
              failedPaths: []
            });
          } catch (batchFailure) {
            batchFailure.successPaths.forEach((p) => {
              recorder.recordSuccess(p, purger.buildFullUrl(p), purger.provider);
            });

            const failedPathIds = [];
            batchFailure.failedPaths.forEach((p) => {
              const failedBatch = batchFailure.batchResults.find(
                (b) => !b.success && b.paths.includes(p)
              );
              const perFileFailure = {
                success: false,
                filePath: p,
                fullUrl: purger.buildFullUrl(p),
                provider: purger.provider,
                attempts: failedBatch ? failedBatch.attempts : [],
                finalAttempt: failedBatch ? failedBatch.finalAttempt : 1,
                error: failedBatch?.error || {
                  message: 'Batch purge failed',
                  code: 'BATCH_FAILED'
                },
                timestamp: batchFailure.timestamp
              };
              const rec = recorder.record(perFileFailure);
              failedPathIds.push({ filePath: p, failureId: rec.id });
            });

            sendResponse(res, 207, {
              success: false,
              mode: 'native-batch',
              total: batchFailure.total,
              successCount: batchFailure.successCount,
              failCount: batchFailure.failCount,
              batchSize: batchFailure.batchSize,
              totalBatches: batchFailure.totalBatches,
              totalDuration: batchFailure.totalDuration,
              provider: purger.provider,
              batchResults: batchFailure.batchResults.map((b) => ({
                batchIndex: b.batchIndex,
                totalBatches: b.totalBatches,
                count: b.count,
                success: b.success,
                retried: b.retried,
                attempts: b.attempts.length,
                duration: b.duration,
                paths: b.paths,
                result: b.result,
                error: b.error
              })),
              successPaths: batchFailure.successPaths,
              failedPaths: failedPathIds
            });
          }
          return;
        }

        const results = [];

        for (const filePath of deduped) {
          try {
            const result = await purger.purgeWithRetry(filePath);

            recorder.recordSuccess(filePath, result.fullUrl, purger.provider);

            results.push({
              filePath,
              success: true,
              fullUrl: result.fullUrl,
              retried: result.retried,
              attempts: result.attempts.length,
              result: {
                statusCode: result.statusCode,
                data: result.data
              }
            });
          } catch (failure) {
            const recorded = recorder.record(failure);
            results.push({
              filePath,
              success: false,
              fullUrl: failure.fullUrl,
              retried: failure.finalAttempt > 1,
              attempts: failure.attempts.length,
              error: failure.error?.message || 'Purge failed',
              errorCode: failure.error?.code,
              failureId: recorded.id,
              recorded: true,
              timestamp: failure.timestamp
            });
          }
        }

        const allSuccess = results.every(r => r.success);

        sendResponse(res, allSuccess ? 200 : 207, {
          success: allSuccess,
          mode: 'per-file',
          total: deduped.length,
          successCount: results.filter(r => r.success).length,
          failCount: results.filter(r => !r.success).length,
          provider: purger.provider,
          results
        });
      } catch (error) {
        console.error('Batch purge error:', error);
        sendResponse(res, 500, {
          success: false,
          error: error.message || 'Internal server error'
        });
      }
    });
    return;
  }

  if (path === '/api/purge-failures' && method === 'GET') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    const result = recorder.getAll({
      status: query.status,
      provider: query.provider,
      limit: query.limit,
      offset: query.offset
    });
    sendResponse(res, 200, result);
    return;
  }

  if (path === '/api/purge-failures/stats' && method === 'GET') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    sendResponse(res, 200, recorder.getStats());
    return;
  }

  if (path.startsWith('/api/purge-failures/') && method === 'GET') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    const id = path.replace('/api/purge-failures/', '');
    const record = recorder.getById(id);
    if (record) {
      sendResponse(res, 200, record);
    } else {
      sendResponse(res, 404, { success: false, error: 'Failure record not found' });
    }
    return;
  }

  if (path.startsWith('/api/purge-failures/') && method === 'DELETE') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    const id = path.replace('/api/purge-failures/', '');
    const removed = recorder.remove(id);
    if (removed) {
      sendResponse(res, 200, { success: true, removed });
    } else {
      sendResponse(res, 404, { success: false, error: 'Failure record not found' });
    }
    return;
  }

  if (path === '/api/purge-failures' && method === 'DELETE') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    const result = recorder.clear({ status: query.status });
    sendResponse(res, 200, { success: true, ...result });
    return;
  }

  if (path === '/api/purge-retry' && method === 'POST') {
    const authError = checkAuth(req);
    if (authError) {
      sendResponse(res, 401, authError);
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        let records = [];

        if (data.failureId) {
          const record = recorder.getById(data.failureId);
          if (!record) {
            sendResponse(res, 404, {
              success: false,
              error: 'Failure record not found'
            });
            return;
          }
          records = [record];
        } else if (Array.isArray(data.failureIds)) {
          records = data.failureIds
            .map((id) => recorder.getById(id))
            .filter(Boolean);
          if (records.length === 0) {
            sendResponse(res, 404, {
              success: false,
              error: 'No matching failure records found'
            });
            return;
          }
        } else if (data.retryAll) {
          records = recorder.getPending();
          if (records.length === 0) {
            sendResponse(res, 200, {
              success: true,
              message: 'No pending failures to retry',
              results: []
            });
            return;
          }
        } else {
          sendResponse(res, 400, {
            success: false,
            error: 'Provide failureId, failureIds array, or { "retryAll": true }'
          });
          return;
        }

        const purger = new CdnPurger({});
        const results = [];

        for (const record of records) {
          recorder.incrementRetryCount(record.id);
          try {
            const result = await purger.purgeWithRetry(record.filePath);

            recorder.recordSuccess(record.filePath, record.fullUrl, purger.provider);

            results.push({
              failureId: record.id,
              filePath: record.filePath,
              success: true,
              retried: result.retried,
              attempts: result.attempts.length,
              result: {
                statusCode: result.statusCode,
                data: result.data
              }
            });
          } catch (failure) {
            const reRecorded = recorder.record(failure);
            results.push({
              failureId: record.id,
              filePath: record.filePath,
              success: false,
              retried: failure.finalAttempt > 1,
              attempts: failure.attempts.length,
              error: failure.error?.message || 'Purge failed',
              errorCode: failure.error?.code,
              newFailureId: reRecorded.id
            });
          }
        }

        const allSuccess = results.every(r => r.success);

        sendResponse(res, allSuccess ? 200 : 207, {
          success: allSuccess,
          total: records.length,
          successCount: results.filter(r => r.success).length,
          failCount: results.filter(r => !r.success).length,
          results
        });
      } catch (error) {
        console.error('Retry error:', error);
        sendResponse(res, 500, {
          success: false,
          error: error.message || 'Internal server error'
        });
      }
    });
    return;
  }

  sendResponse(res, 404, {
    success: false,
    error: 'Not found',
    availableEndpoints: [
      { method: 'GET', path: '/health', description: 'Health check' },
      { method: 'POST', path: '/api/purge', description: 'Purge single file cache (with retry)', body: { filePath: 'string' } },
      { method: 'POST', path: '/api/purge-batch', description: 'Purge multiple files in batch (native batch API + retry)', body: { filePaths: 'string[]', useNativeBatch: 'boolean (default true)' } },
      { method: 'GET', path: '/api/purge-failures', description: 'Query failure records', query: { status: 'pending|resolved', provider: 'string', limit: 'number', offset: 'number' } },
      { method: 'GET', path: '/api/purge-failures/stats', description: 'Get failure statistics' },
      { method: 'GET', path: '/api/purge-failures/:id', description: 'Get a single failure record' },
      { method: 'DELETE', path: '/api/purge-failures/:id', description: 'Delete a failure record' },
      { method: 'DELETE', path: '/api/purge-failures?status=pending', description: 'Clear failure records by status' },
      { method: 'POST', path: '/api/purge-retry', description: 'Retry failed purge tasks', body: { failureId: 'string' } | { failureIds: 'string[]' } | { retryAll: true } }
    ]
  });
});

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

function checkAuth(req) {
  if (!API_KEY) {
    return null;
  }

  const providedKey = req.headers['x-api-key'];

  if (!providedKey || providedKey !== API_KEY) {
    return {
      success: false,
      error: 'Unauthorized: Invalid or missing API key'
    };
  }

  return null;
}

function sendResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  const samplePurger = new CdnPurger({});
  console.log(`
  ██████╗ ██████╗ ███╗   ██╗    ██████╗ ██╗   ██╗██████╗  ██████╗ ███████╗
  ██╔══██╗██╔══██╗████╗  ██║    ██╔══██╗██║   ██║██╔══██╗██╔════╝ ██╔════╝
  ██████╔╝██║  ██║██╔██╗ ██║    ██████╔╝██║   ██║██████╔╝██║  ███╗█████╗  
  ██╔═══╝ ██║  ██║██║╚██╗██║    ██╔═══╝ ██║   ██║██╔══██╗██║   ██║██╔══╝  
  ██║     ██████╔╝██║ ╚████║    ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
  ╚═╝     ╚═════╝ ╚═╝  ╚═══╝    ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
  `);
  console.log(`CDN Purge Service running on http://localhost:${PORT}`);
  console.log(`CDN Provider: ${process.env.CDN_PROVIDER || 'not configured'}`);
  console.log(`CDN Domain: ${process.env.CDN_DOMAIN || 'not configured'}`);
  console.log(`API Key Auth: ${API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`Retry: maxRetries=${samplePurger.maxRetries}, baseDelay=${samplePurger.retryBaseDelay}ms, backoff=${samplePurger.retryBackoffFactor}x`);
  console.log(`Batch: size=${samplePurger.batchSize}/batch (default for ${samplePurger.provider})`);
  console.log(`Failure records: ${recorder.storageDir}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET    /health                    - Health check');
  console.log('  POST   /api/purge                 - Purge single file (with retry)');
  console.log('  POST   /api/purge-batch           - Purge multiple files (native batch + retry)');
  console.log('  GET    /api/purge-failures        - Query failure records');
  console.log('  GET    /api/purge-failures/stats  - Get failure statistics');
  console.log('  GET    /api/purge-failures/:id    - Get a single failure record');
  console.log('  DELETE /api/purge-failures/:id    - Delete a failure record');
  console.log('  DELETE /api/purge-failures        - Clear failure records (?status=pending)');
  console.log('  POST   /api/purge-retry           - Retry failed purge tasks');
  console.log('');
});
