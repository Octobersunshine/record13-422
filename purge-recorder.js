const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PurgeRecorder {
  constructor(options = {}) {
    this.storageDir = options.storageDir || process.env.PURGE_RECORD_DIR || path.join(process.cwd(), 'records');
    this.failuresFile = path.join(this.storageDir, 'purge-failures.json');
    this.maxRecords = options.maxRecords !== undefined
      ? options.maxRecords
      : (process.env.PURGE_MAX_RECORDS ? parseInt(process.env.PURGE_MAX_RECORDS, 10) : 10000);
    this.ensureStorage();
    this.failures = this.loadFailures();
  }

  ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  loadFailures() {
    try {
      if (fs.existsSync(this.failuresFile)) {
        const content = fs.readFileSync(this.failuresFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Failed to load purge failure records:', error.message);
    }
    return [];
  }

  persist() {
    try {
      fs.writeFileSync(this.failuresFile, JSON.stringify(this.failures, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to persist purge failure records:', error.message);
    }
  }

  generateId(filePath, fullUrl) {
    const base = `${filePath}|${fullUrl}`;
    return crypto.createHash('md5').update(base).digest('hex').substring(0, 12);
  }

  record(failure) {
    const id = this.generateId(failure.filePath, failure.fullUrl);
    const existingIndex = this.failures.findIndex((f) => f.id === id);

    const record = {
      id,
      filePath: failure.filePath,
      fullUrl: failure.fullUrl,
      provider: failure.provider,
      attempts: failure.attempts,
      finalAttempt: failure.finalAttempt,
      error: failure.error,
      status: 'pending',
      createdAt: existingIndex >= 0 ? this.failures[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCount: existingIndex >= 0 ? (this.failures[existingIndex].retryCount || 0) : 0,
      history: existingIndex >= 0
        ? [...(this.failures[existingIndex].history || []), {
          timestamp: new Date().toISOString(),
          error: failure.error,
          finalAttempt: failure.finalAttempt
        }]
        : [{
          timestamp: new Date().toISOString(),
          error: failure.error,
          finalAttempt: failure.finalAttempt
        }]
    };

    if (existingIndex >= 0) {
      this.failures[existingIndex] = record;
    } else {
      this.failures.unshift(record);
      if (this.failures.length > this.maxRecords) {
        this.failures = this.failures.slice(0, this.maxRecords);
      }
    }

    this.persist();
    return record;
  }

  recordSuccess(filePath, fullUrl, provider) {
    const id = this.generateId(filePath, fullUrl);
    const existingIndex = this.failures.findIndex((f) => f.id === id);

    if (existingIndex >= 0) {
      const existing = this.failures[existingIndex];
      existing.status = 'resolved';
      existing.updatedAt = new Date().toISOString();
      existing.resolvedAt = new Date().toISOString();
      existing.history = [...(existing.history || []), {
        timestamp: new Date().toISOString(),
        event: 'resolved'
      }];
      this.failures[existingIndex] = existing;
      this.persist();
      return existing;
    }

    return null;
  }

  incrementRetryCount(id) {
    const index = this.failures.findIndex((f) => f.id === id);
    if (index >= 0) {
      this.failures[index].retryCount = (this.failures[index].retryCount || 0) + 1;
      this.failures[index].updatedAt = new Date().toISOString();
      this.persist();
      return this.failures[index];
    }
    return null;
  }

  getAll(options = {}) {
    let results = [...this.failures];

    if (options.status) {
      results = results.filter((f) => f.status === options.status);
    }

    if (options.provider) {
      results = results.filter((f) => f.provider === options.provider);
    }

    const limit = options.limit ? parseInt(options.limit, 10) : 100;
    const offset = options.offset ? parseInt(options.offset, 10) : 0;

    return {
      total: results.length,
      limit,
      offset,
      records: results.slice(offset, offset + limit)
    };
  }

  getById(id) {
    return this.failures.find((f) => f.id === id) || null;
  }

  getPending() {
    return this.failures.filter((f) => f.status === 'pending');
  }

  remove(id) {
    const index = this.failures.findIndex((f) => f.id === id);
    if (index >= 0) {
      const removed = this.failures[index];
      this.failures.splice(index, 1);
      this.persist();
      return removed;
    }
    return null;
  }

  clear(options = {}) {
    if (options.status) {
      const before = this.failures.length;
      this.failures = this.failures.filter((f) => f.status !== options.status);
      this.persist();
      return { removed: before - this.failures.length };
    }
    const count = this.failures.length;
    this.failures = [];
    this.persist();
    return { removed: count };
  }

  getStats() {
    return {
      total: this.failures.length,
      pending: this.failures.filter((f) => f.status === 'pending').length,
      resolved: this.failures.filter((f) => f.status === 'resolved').length,
      byProvider: this.failures.reduce((acc, f) => {
        acc[f.provider] = (acc[f.provider] || 0) + 1;
        return acc;
      }, {})
    };
  }
}

module.exports = PurgeRecorder;
