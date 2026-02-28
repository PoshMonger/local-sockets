import initSqlJs from 'sql.js';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SQLITE_PATH || join(__dirname, '..', 'data', 'streams.db');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

let db;

function getKey() {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) return null;
  return scryptSync(ENCRYPTION_KEY, 'stream-salt', 32);
}

function encryptAtRest(plain) {
  const key = getKey();
  if (!key) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptAtRest(enc) {
  const key = getKey();
  if (!key) return enc;
  try {
    const buf = Buffer.from(enc, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return enc;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final('utf8');
  } catch {
    return enc;
  }
}

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('DB persist failed:', e.message);
  }
}

export async function initDb() {
  const dataDir = join(__dirname, '..', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const SQL = await initSqlJs();
  let buffer;
  if (existsSync(DB_PATH)) {
    buffer = readFileSync(DB_PATH);
  }
  db = new SQL.Database(buffer);

  db.run(`
    CREATE TABLE IF NOT EXISTS streams (
      stream_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id TEXT NOT NULL,
      role TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      viewer_count INTEGER,
      frame_count INTEGER DEFAULT 0,
      FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_streams_active ON streams(is_active)`);

  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

const SALT_ROUNDS = 10;

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(plain, stored) {
  const hash = decryptAtRest(stored);
  return bcrypt.compare(plain, hash);
}

export function createStream(streamId, passwordHash) {
  const d = getDb();
  const now = Date.now();
  const stored = encryptAtRest(passwordHash);
  d.run(
    'INSERT INTO streams (stream_id, password_hash, created_at, is_active) VALUES (?, ?, ?, 1)',
    [streamId, stored, now]
  );
  persist();
  return { stream_id: streamId, created_at: now };
}

export function setStreamActive(streamId, active) {
  getDb().run('UPDATE streams SET is_active = ? WHERE stream_id = ?', [active ? 1 : 0, streamId]);
  persist();
}

export function getStream(streamId) {
  const d = getDb();
  const stmt = d.prepare('SELECT * FROM streams WHERE stream_id = ?');
  stmt.bind([streamId]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row || null;
}

export function startSession(streamId, role) {
  const d = getDb();
  const now = Date.now();
  d.run('INSERT INTO sessions (stream_id, role, started_at) VALUES (?, ?, ?)', [streamId, role, now]);
  const stmt = d.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const r = stmt.getAsObject();
  stmt.free();
  persist();
  return { id: r.id, started_at: now };
}

export function endSession(sessionId, viewerCount = null, frameCount = null) {
  getDb().run(
    'UPDATE sessions SET ended_at = ?, viewer_count = ?, frame_count = ? WHERE id = ?',
    [Date.now(), viewerCount ?? null, frameCount ?? null, sessionId]
  );
  persist();
}

export function updateSessionFrameCount(sessionId, count) {
  getDb().run('UPDATE sessions SET frame_count = ? WHERE id = ?', [count, sessionId]);
  persist();
}

export function listActiveStreams() {
  const d = getDb();
  const result = d.exec('SELECT stream_id, created_at FROM streams WHERE is_active = 1');
  if (!result.length || !result[0].values.length) return [];
  const cols = result[0].columns;
  return result[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}
