// queue.js
// Cola de jobs ligera con persistencia en SQLite. Reemplazable por BullMQ + Redis
// cuando se quiera escalar a múltiples workers/máquinas.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Preferir sqlite nativo de Node 22+; fallback a better-sqlite3 si está instalido.
let Database;
try {
  Database = require('node:sqlite').DatabaseSync;
} catch {
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error('Se necesita Node.js 22+ con node:sqlite, o better-sqlite3 instalado.');
  }
}

const DB_PATH = process.env.QUEUE_DB_PATH || path.join(__dirname, 'jobs.sqlite');

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.db = new Database(DB_PATH);
    this._init();
  }

  _init() {
    // El dashboard y el worker comparten el mismo archivo SQLite. Sin WAL +
    // busy_timeout, un lock transitorio lanza ERR_SQLITE_ERROR y tumba el
    // proceso (crash visto en producción: "database is locked" en claimNext).
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        maxRetries INTEGER NOT NULL DEFAULT 3,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_created ON jobs(createdAt);
    `);
  }

  _prepare(sql) {
    return this.db.prepare ? this.db.prepare(sql) : this.db.prepare(sql);
  }

  add(type, payload, options = {}) {
    const id = options.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maxRetries = options.maxRetries ?? 3;
    const createdAt = new Date().toISOString();
    const stmt = this._prepare(
      'INSERT INTO jobs (id, type, payload, status, maxRetries, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.run(id, type, JSON.stringify(payload), 'pending', maxRetries, createdAt);
    this.emit('added', { id, type, payload });
    return id;
  }

  get(id) {
    const stmt = this._prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._hydrate(row) : null;
  }

  list({ status, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM jobs';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const stmt = this._prepare(sql);
    return stmt.all(...params).map((r) => this._hydrate(r));
  }

  claimNext({ excludeTypes } = {}) {
    let sql = "SELECT * FROM jobs WHERE status = 'pending'";
    const params = [];
    if (Array.isArray(excludeTypes) && excludeTypes.length > 0) {
      sql += ` AND type NOT IN (${excludeTypes.map(() => '?').join(',')})`;
      params.push(...excludeTypes);
    }
    sql += ' ORDER BY createdAt ASC LIMIT 1';
    const stmt = this._prepare(sql);
    const row = stmt.get(...params);
    if (!row) return null;

    const update = this._prepare(
      "UPDATE jobs SET status = 'running', startedAt = ? WHERE id = ? AND status = 'pending'"
    );
    const startedAt = new Date().toISOString();
    const result = update.run(startedAt, row.id);
    if (result.changes === 0) return null; // otro worker lo tomó

    return this._hydrate({ ...row, status: 'running', startedAt });
  }

  // Claim atómico filtrado por tipos: lo usa el worker remoto (Mac) vía API.
  claimNextTypes(types) {
    if (!Array.isArray(types) || types.length === 0) return null;
    const sql = `SELECT * FROM jobs WHERE status = 'pending' AND type IN (${types.map(() => '?').join(',')}) ORDER BY createdAt ASC LIMIT 1`;
    const row = this._prepare(sql).get(...types);
    if (!row) return null;
    const update = this._prepare(
      "UPDATE jobs SET status = 'running', startedAt = ? WHERE id = ? AND status = 'pending'"
    );
    const startedAt = new Date().toISOString();
    const result = update.run(startedAt, row.id);
    if (result.changes === 0) return null;
    return this._hydrate({ ...row, status: 'running', startedAt });
  }

  updateProgress(id, progress) {
    const stmt = this._prepare('UPDATE jobs SET progress = ? WHERE id = ?');
    stmt.run(JSON.stringify(progress), id);
    this.emit('progress', { id, progress });
  }

  complete(id, result) {
    const stmt = this._prepare(
      "UPDATE jobs SET status = 'completed', completedAt = ?, progress = ? WHERE id = ?"
    );
    const completedAt = new Date().toISOString();
    const progress = result?.progress ? JSON.stringify(result.progress) : null;
    stmt.run(completedAt, progress, id);
    this.emit('completed', { id, result });
  }

  fail(id, error, allowRetry = true) {
    const job = this.get(id);
    if (!job) return;

    const shouldRetry = allowRetry && job.retries < job.maxRetries;
    if (shouldRetry) {
      const stmt = this._prepare(
        "UPDATE jobs SET status = 'pending', retries = retries + 1, error = ? WHERE id = ?"
      );
      stmt.run(String(error), id);
      this.emit('retry', { id, retries: job.retries + 1, error });
    } else {
      const stmt = this._prepare(
        "UPDATE jobs SET status = 'failed', completedAt = ?, error = ? WHERE id = ?"
      );
      stmt.run(new Date().toISOString(), String(error), id);
      this.emit('failed', { id, error });
    }
  }

  cancel(id) {
    const job = this.get(id);
    // Pendientes: se cancelan directo. Running: se marca 'cancelled' y el
    // worker lo detecta entre sub-renders (o con su watcher) y limpia.
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return false;
    const stmt = this._prepare("UPDATE jobs SET status = 'cancelled', completedAt = ? WHERE id = ?");
    stmt.run(new Date().toISOString(), id);
    this.emit('cancelled', { id });
    return true;
  }

  countByStatus(status) {
    const stmt = this._prepare('SELECT COUNT(*) as count FROM jobs WHERE status = ?');
    const row = stmt.get(status);
    return row ? row.count : 0;
  }

  countPending() {
    return this.countByStatus('pending');
  }

  countRunning() {
    return this.countByStatus('running');
  }

  getRunning() {
    const stmt = this._prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY startedAt ASC LIMIT 1");
    const row = stmt.get();
    return row ? this._hydrate(row) : null;
  }

  _hydrate(row) {
    return {
      ...row,
      payload: JSON.parse(row.payload),
      progress: row.progress ? JSON.parse(row.progress) : null,
    };
  }
}

module.exports = { JobQueue };
