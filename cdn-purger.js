const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

class CdnPurger {
  constructor(config) {
    this.provider = config.provider || process.env.CDN_PROVIDER;
    this.accessKeyId = config.accessKeyId || process.env.CDN_ACCESS_KEY_ID;
    this.accessKeySecret = config.accessKeySecret || process.env.CDN_ACCESS_KEY_SECRET;
    this.endpoint = config.endpoint || process.env.CDN_ENDPOINT;
    this.domain = config.domain || process.env.CDN_DOMAIN;
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

  buildFullUrl(filePath) {
    const path = filePath.startsWith('/') ? filePath : `/${filePath}`;
    return `https://${this.domain}${path}`;
  }

  async purgeAliyun(url) {
    const action = 'RefreshObjectCaches';
    const version = '2018-05-10';
    const timestamp = new Date().toISOString();
    const nonce = Math.random().toString(36).substring(2, 15);

    const params = {
      Action: action,
      Version: version,
      Format: 'JSON',
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: timestamp,
      SignatureVersion: '1.0',
      SignatureNonce: nonce,
      ObjectPath: url,
      ObjectType: 'File'
    };

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
    const action = 'PurgeUrlsCache';
    const version = '2018-06-06';
    const service = 'cdn';
    const host = this.endpoint || 'cdn.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];

    const payload = JSON.stringify({
      Urls: [url]
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
    const host = this.endpoint || 'fusion.qiniuapi.com';
    const path = '/v2/tune/refresh';
    const payload = JSON.stringify({
      urls: [url]
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
      files: [url]
    });

    return this.makeRequest(options, 'POST', payload);
  }

  makeRequest(options, method, body = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
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

      req.on('error', (error) => {
        reject({
          success: false,
          error: error.message
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
