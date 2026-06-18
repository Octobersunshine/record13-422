const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const DEFAULT_RETRYABLE_ERRORS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED'
];

const BATCH_LIMITS = {
  aliyun: 1000,
  tencent: 100,
  qiniu: 100,
  cloudflare: 30
};

class CdnPurger {
  constructor(config) {
    this.provider = config.provider || process.env.CDN_PROVIDER;
    this.accessKeyId = config.accessKeyId || process.env.CDN_ACCESS_KEY_ID;
    this.accessKeySecret = config.accessKeySecret || process.env.CDN_ACCESS_KEY_SECRET;
    this.endpoint = config.endpoint || process.env.CDN_ENDPOINT;
    this.domain = config.domain || process.env.CDN_DOMAIN;

    this.maxRetries = config.maxRetries !== undefined
      ? config.maxRetries
      : (process.env.PURGE_MAX_RETRIES !== undefined
        ? parseInt(process.env.PURGE_MAX_RETRIES, 10)
        : 3);
    this.retryBaseDelay = config.retryBaseDelay !== undefined
      ? config.retryBaseDelay
      : (process.env.PURGE_RETRY_BASE_DELAY
        ? parseInt(process.env.PURGE_RETRY_BASE_DELAY, 10)
        : 1000);
    this.retryBackoffFactor = config.retryBackoffFactor !== undefined
      ? config.retryBackoffFactor
      : (process.env.PURGE_RETRY_BACKOFF_FACTOR
        ? parseFloat(process.env.PURGE_RETRY_BACKOFF_FACTOR)
        : 2);
    this.retryableStatusCodes = config.retryableStatusCodes || DEFAULT_RETRYABLE_STATUS_CODES;
    this.retryableErrors = config.retryableErrors || DEFAULT_RETRYABLE_ERRORS;

    const defaultBatchSize = BATCH_LIMITS[this.provider] || 50;
    this.batchSize = config.batchSize !== undefined
      ? config.batchSize
      : (process.env.PURGE_BATCH_SIZE
        ? parseInt(process.env.PURGE_BATCH_SIZE, 10)
        : defaultBatchSize);
  }

  async purge(filePath) {
    if (!filePath) {
      throw new Error('File path is required');
    }

    const url = this.buildFullUrl(filePath);

    switch (this.provider) {
      case 'aliyun':
        return this.purgeAliyun(url);
      case 'tencent':
        return this.purgeTencent(url);
      case 'qiniu':
        return this.purgeQiniu(url);
      case 'cloudflare':
        return this.purgeCloudflare(url);
      default:
        throw new Error(`Unsupported CDN provider: ${this.provider}`);
    }
  }

  async purgeWithRetry(filePath) {
    if (!filePath) {
      throw new Error('File path is required');
    }

    const fullUrl = this.buildFullUrl(filePath);
    let lastError = null;
    const attempts = [];

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      const attemptStart = Date.now();
      try {
        const result = await this.purge(filePath);
        attempts.push({
          attempt,
          success: true,
          statusCode: result.statusCode,
          duration: Date.now() - attemptStart
        });
        result.attempts = attempts;
        result.filePath = filePath;
        result.fullUrl = fullUrl;
        result.finalAttempt = attempt;
        result.retried = attempt > 1;
        return result;
      } catch (error) {
        const isLast = attempt > this.maxRetries;
        const errorInfo = this.normalizeError(error);
        const shouldRetry = !isLast && this.shouldRetry(errorInfo);

        attempts.push({
          attempt,
          success: false,
          statusCode: errorInfo.statusCode,
          errorCode: errorInfo.code,
          errorMessage: errorInfo.message,
          duration: Date.now() - attemptStart,
          willRetry: shouldRetry
        });

        lastError = errorInfo;

        if (!shouldRetry) {
          break;
        }

        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
      }
    }

    const failure = {
      success: false,
      filePath,
      fullUrl,
      provider: this.provider,
      attempts,
      finalAttempt: attempts.length,
      error: lastError,
      timestamp: new Date().toISOString()
    };
    throw failure;
  }

  async purgeBatch(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('filePaths array is required');
    }

    const deduped = [...new Set(filePaths)];
    const urls = deduped.map((p) => this.buildFullUrl(p));

    switch (this.provider) {
      case 'aliyun':
        return this.purgeBatchAliyun(deduped, urls);
      case 'tencent':
        return this.purgeBatchTencent(deduped, urls);
      case 'qiniu':
        return this.purgeBatchQiniu(deduped, urls);
      case 'cloudflare':
        return this.purgeBatchCloudflare(deduped, urls);
      default:
        throw new Error(`Unsupported CDN provider: ${this.provider}`);
    }
  }

  async purgeBatchWithRetry(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('filePaths array is required');
    }

    const deduped = [...new Set(filePaths)];
    const urlMap = new Map(deduped.map((p) => [p, this.buildFullUrl(p)]));

    const batches = [];
    for (let i = 0; i < deduped.length; i += this.batchSize) {
      batches.push(deduped.slice(i, i + this.batchSize));
    }

    const overallStart = Date.now();
    const batchResults = [];
    let allSuccess = true;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchPaths = batches[batchIndex];
      const batchUrls = batchPaths.map((p) => urlMap.get(p));
      const batchStart = Date.now();
      let lastError = null;
      const attempts = [];
      let batchSuccess = false;
      let finalResult = null;

      for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
        const attemptStart = Date.now();
        try {
          const result = await this.purgeBatch(batchPaths);
          attempts.push({
            attempt,
            success: true,
            statusCode: result.statusCode,
            duration: Date.now() - attemptStart
          });
          finalResult = result;
          batchSuccess = true;
          break;
        } catch (error) {
          const isLast = attempt > this.maxRetries;
          const errorInfo = this.normalizeError(error);
          const shouldRetry = !isLast && this.shouldRetry(errorInfo);

          attempts.push({
            attempt,
            success: false,
            statusCode: errorInfo.statusCode,
            errorCode: errorInfo.code,
            errorMessage: errorInfo.message,
            duration: Date.now() - attemptStart,
            willRetry: shouldRetry
          });

          lastError = errorInfo;

          if (!shouldRetry) {
            break;
          }

          const delay = this.calculateBackoff(attempt);
          await this.sleep(delay);
        }
      }

      const batchOutcome = {
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        paths: batchPaths,
        urls: batchUrls,
        count: batchPaths.length,
        success: batchSuccess,
        retried: attempts.length > 1,
        attempts,
        finalAttempt: attempts.length,
        duration: Date.now() - batchStart
      };

      if (batchSuccess) {
        batchOutcome.result = {
          statusCode: finalResult.statusCode,
          data: finalResult.data
        };
      } else {
        batchOutcome.error = lastError;
        batchOutcome.failedPaths = batchPaths;
        allSuccess = false;
      }

      batchResults.push(batchOutcome);
    }

    const successPaths = [];
    const failedPaths = [];
    batchResults.forEach((b) => {
      if (b.success) {
        successPaths.push(...b.paths);
      } else {
        failedPaths.push(...b.paths);
      }
    });

    const overall = {
      success: allSuccess,
      provider: this.provider,
      total: deduped.length,
      batchSize: this.batchSize,
      totalBatches: batches.length,
      successCount: successPaths.length,
      failCount: failedPaths.length,
      successPaths,
      failedPaths,
      batchResults,
      totalDuration: Date.now() - overallStart,
      timestamp: new Date().toISOString()
    };

    if (!allSuccess) {
      throw overall;
    }
    return overall;
  }

  chunk(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  normalizeError(error) {
    if (!error) {
      return { message: 'Unknown error', code: 'UNKNOWN' };
    }

    if (error.code && this.retryableErrors.includes(error.code)) {
      return {
        code: error.code,
        message: error.message || error.code,
        isNetworkError: true
      };
    }

    if (error.statusCode !== undefined) {
      return {
        code: error.code || `HTTP_${error.statusCode}`,
        statusCode: error.statusCode,
        message: error.error?.Message || error.error?.message || error.message || `HTTP ${error.statusCode}`,
        isNetworkError: false
      };
    }

    if (error.message) {
      const matched = this.retryableErrors.find((code) => error.message.includes(code));
      if (matched) {
        return { code: matched, message: error.message, isNetworkError: true };
      }
      return { code: 'UNKNOWN', message: error.message, isNetworkError: false };
    }

    return {
      code: 'UNKNOWN',
      message: typeof error === 'string' ? error : JSON.stringify(error),
      isNetworkError: false
    };
  }

  shouldRetry(errorInfo) {
    if (errorInfo.isNetworkError) {
      return true;
    }
    if (errorInfo.statusCode && this.retryableStatusCodes.includes(errorInfo.statusCode)) {
      return true;
    }
    return false;
  }

  calculateBackoff(attempt) {
    const delay = this.retryBaseDelay * Math.pow(this.retryBackoffFactor, attempt - 1);
    const jitter = Math.floor(Math.random() * this.retryBaseDelay * 0.3);
    return Math.floor(delay + jitter);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildFullUrl(filePath) {
    const path = filePath.startsWith('/') ? filePath : `/${filePath}`;
    return `https://${this.domain}${path}`;
  }

  async purgeAliyun(url) {
    return this.purgeBatchAliyun([url], [url]);
  }

  async purgeBatchAliyun(paths, urls) {
    const action = 'RefreshObjectCaches';
    const version = '2018-05-10';
    const timestamp = new Date().toISOString();
    const nonce = Math.random().toString(36).substring(2, 15);

    const joinedUrls = urls.join('\n');

    const params = {
      Action: action,
      Version: version,
      Format: 'JSON',
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: timestamp,
      SignatureVersion: '1.0',
      SignatureNonce: nonce,
      ObjectPath: joinedUrls
    };

    if (urls.length === 1) {
      params.ObjectType = 'File';
    }

    const signature = this.signAliyun(params, this.accessKeySecret);
    params.Signature = signature;

    const queryString = new URLSearchParams(params).toString();
    const fullUrl = `https://${this.endpoint || 'cdn.aliyuncs.com'}?${queryString}`;

    return this.makeRequest(fullUrl, 'GET');
  }

  signAliyun(params, secret) {
    const sortedParams = Object.keys(params).sort().reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});

    const queryString = new URLSearchParams(sortedParams).toString();
    const stringToSign = `GET&%2F&${encodeURIComponent(queryString)}`;

    return crypto
      .createHmac('sha1', `${secret}&`)
      .update(stringToSign)
      .digest('base64');
  }

  async purgeTencent(url) {
    return this.purgeBatchTencent([url], [url]);
  }

  async purgeBatchTencent(paths, urls) {
    const action = 'PurgeUrlsCache';
    const version = '2018-06-06';
    const service = 'cdn';
    const host = this.endpoint || 'cdn.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];

    const payload = JSON.stringify({
      Urls: urls
    });

    const authorization = this.signTencent({
      service,
      host,
      timestamp,
      date,
      payload,
      action,
      version
    });

    const options = {
      hostname: host,
      path: '/',
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'X-TC-Action': action,
        'X-TC-Timestamp': timestamp,
        'X-TC-Version': version,
        'Host': host
      }
    };

    return this.makeRequest(options, 'POST', payload);
  }

  signTencent({ service, host, timestamp, date, payload, action, version }) {
    const algorithm = 'TC3-HMAC-SHA256';

    const hashedRequestPayload = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex');

    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';

    const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

    const hashedCanonicalRequest = crypto
      .createHash('sha256')
      .update(canonicalRequest)
      .digest('hex');

    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const secretDate = crypto
      .createHmac('sha256', `TC3${this.accessKeySecret}`)
      .update(date)
      .digest();

    const secretService = crypto
      .createHmac('sha256', secretDate)
      .update(service)
      .digest();

    const secretSigning = crypto
      .createHmac('sha256', secretService)
      .update('tc3_request')
      .digest();

    const signature = crypto
      .createHmac('sha256', secretSigning)
      .update(stringToSign)
      .digest('hex');

    return `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  async purgeQiniu(url) {
    return this.purgeBatchQiniu([url], [url]);
  }

  async purgeBatchQiniu(paths, urls) {
    const host = this.endpoint || 'fusion.qiniuapi.com';
    const path = '/v2/tune/refresh';
    const payload = JSON.stringify({
      urls: urls
    });

    const signToken = this.signQiniu(path, payload);

    const options = {
      hostname: host,
      path: path,
      method: 'POST',
      headers: {
        'Authorization': `QBox ${signToken}`,
        'Content-Type': 'application/json'
      }
    };

    return this.makeRequest(options, 'POST', payload);
  }

  signQiniu(path, body) {
    const data = `${path}\n${body}`;
    const sign = crypto
      .createHmac('sha1', this.accessKeySecret)
      .update(data)
      .digest('base64');

    const encodedSign = this.safeBase64Encode(sign);
    return `${this.accessKeyId}:${encodedSign}`;
  }

  safeBase64Encode(str) {
    return Buffer.from(str, 'binary')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  async purgeCloudflare(url) {
    return this.purgeBatchCloudflare([url], [url]);
  }

  async purgeBatchCloudflare(paths, urls) {
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!zoneId) {
      throw new Error('CLOUDFLARE_ZONE_ID is required for Cloudflare');
    }

    const options = {
      hostname: this.endpoint || 'api.cloudflare.com',
      path: `/client/v4/zones/${zoneId}/purge_cache`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessKeySecret}`,
        'Content-Type': 'application/json',
        'X-Auth-Email': this.accessKeyId
      }
    };

    const payload = JSON.stringify({
      files: urls
    });

    return this.makeRequest(options, 'POST', payload);
  }

  makeRequest(options, method, body = null) {
    const timeout = process.env.PURGE_REQUEST_TIMEOUT
      ? parseInt(process.env.PURGE_REQUEST_TIMEOUT, 10)
      : 10000;

    return new Promise((resolve, reject) => {
      let settled = false;

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({
                success: true,
                statusCode: res.statusCode,
                data: result
              });
            } else {
              reject({
                success: false,
                statusCode: res.statusCode,
                error: result
              });
            }
          } catch (e) {
            resolve({
              success: res.statusCode >= 200 && res.statusCode < 300,
              statusCode: res.statusCode,
              rawResponse: data
            });
          }
        });
      });

      req.setTimeout(timeout, () => {
        if (settled) return;
        settled = true;
        req.destroy();
        const error = new Error(`Request timed out after ${timeout}ms`);
        error.code = 'ETIMEDOUT';
        reject({
          success: false,
          error: error.message,
          code: 'ETIMEDOUT'
        });
      });

      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject({
          success: false,
          error: error.message,
          code: error.code || 'ECONNERROR'
        });
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }
}

module.exports = CdnPurger;
