require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const CdnPurger = require('./cdn-purger');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method;

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
        const result = await purger.purge(filePath);

        sendResponse(res, 200, {
          success: true,
          filePath: filePath,
          fullUrl: purger.buildFullUrl(filePath),
          provider: purger.provider,
          result: result
        });
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

        if (!Array.isArray(filePaths) || filePaths.length === 0) {
          sendResponse(res, 400, {
            success: false,
            error: 'filePaths array is required'
          });
          return;
        }

        const purger = new CdnPurger({});
        const results = [];

        for (const filePath of filePaths) {
          try {
            const result = await purger.purge(filePath);
            results.push({
              filePath,
              success: true,
              fullUrl: purger.buildFullUrl(filePath),
              result
            });
          } catch (err) {
            const errorMessage = err.error?.Message || err.error?.message || err.message || JSON.stringify(err.error || err);
            results.push({
              filePath,
              success: false,
              error: errorMessage
            });
          }
        }

        const allSuccess = results.every(r => r.success);

        sendResponse(res, allSuccess ? 200 : 207, {
          success: allSuccess,
          total: filePaths.length,
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

  sendResponse(res, 404, {
    success: false,
    error: 'Not found',
    availableEndpoints: [
      { method: 'GET', path: '/health', description: 'Health check' },
      { method: 'POST', path: '/api/purge', description: 'Purge single file cache', body: { filePath: 'string' } },
      { method: 'POST', path: '/api/purge-batch', description: 'Purge multiple files cache', body: { filePaths: 'string[]' } }
    ]
  });
});

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  /health        - Health check');
  console.log('  POST /api/purge     - Purge single file');
  console.log('  POST /api/purge-batch - Purge multiple files');
  console.log('');
});
