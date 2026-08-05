const crypto = require('node:crypto');
const { all, get, run } = require('../../db');

const PASTE_ID_LENGTH = 10;
const PASTE_SALT_LENGTH = 12;
const MAX_CONTENT_SIZE = 1024 * 1024;

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += chars[bytes[i] % chars.length];
  }
  return output;
}

function normalizePasteId(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(value)) return '';
  return value;
}

function normalizeLanguage(rawValue = '') {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+-]/g, '');
  return normalized.slice(0, 40) || 'text';
}

function normalizeExpiresIn(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isExpired(row = {}, now = Date.now()) {
  const expiresAt = Number(row.expires_at || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && now > expiresAt;
}

function summarize(row = {}) {
  return {
    id: row.id,
    language: row.language || 'text',
    createdAt: Number(row.created_at || 0),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at || 0),
    hasPassword: Boolean(row.password_hash),
    size: Number(row.size || 0),
  };
}

class PasteRepository {
  constructor(db) {
    this.db = db;
  }

  generateUniquePasteId(maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = randomString(PASTE_ID_LENGTH);
      const exists = get(this.db, 'SELECT id FROM pastes WHERE id = ?', [candidate]);
      if (!exists) return candidate;
    }
    throw new Error('Failed to generate a unique paste id.');
  }

  create({ content, language = 'text', expiresIn = null, password = '' }) {
    const normalizedContent = String(content || '');
    if (!normalizedContent.trim()) {
      throw new Error('Paste content is required.');
    }

    const byteLength = Buffer.byteLength(normalizedContent, 'utf8');
    if (byteLength > MAX_CONTENT_SIZE) {
      throw new Error('Paste content exceeds 1 MiB limit.');
    }

    const now = Date.now();
    const expiresInSeconds = normalizeExpiresIn(expiresIn);
    const expiresAt = expiresInSeconds ? now + expiresInSeconds * 1000 : null;
    const normalizedPassword = String(password || '');
    const passwordSalt = normalizedPassword ? randomString(PASTE_SALT_LENGTH) : null;
    const passwordHash = normalizedPassword ? hashPassword(normalizedPassword, passwordSalt) : null;
    const id = this.generateUniquePasteId();

    run(
      this.db,
      `INSERT INTO pastes(
        id, content, language, password_salt, password_hash, size, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalizedContent,
        normalizeLanguage(language),
        passwordSalt,
        passwordHash,
        byteLength,
        now,
        expiresAt,
      ]
    );

    return summarize(this.getRawById(id));
  }

  getRawById(id) {
    const pasteId = normalizePasteId(id);
    if (!pasteId) return null;
    return get(this.db, 'SELECT * FROM pastes WHERE id = ?', [pasteId]) || null;
  }

  getById(id, { password = '' } = {}) {
    const row = this.getRawById(id);
    if (!row) {
      return {
        ok: false,
        status: 404,
        code: 'PASTE_NOT_FOUND',
        message: 'Paste not found.',
      };
    }

    if (isExpired(row)) {
      this.delete(id);
      return {
        ok: false,
        status: 404,
        code: 'PASTE_EXPIRED',
        message: 'Paste has expired.',
      };
    }

    if (row.password_hash && !String(password || '')) {
      return {
        ok: false,
        status: 401,
        code: 'PASTE_PASSWORD_REQUIRED',
        message: 'Paste password is required.',
      };
    }

    if (row.password_hash) {
      const expected = hashPassword(String(password || ''), String(row.password_salt || ''));
      if (!timingSafeEqualHex(expected, row.password_hash)) {
        return {
          ok: false,
          status: 403,
          code: 'PASTE_PASSWORD_INVALID',
          message: 'Paste password is invalid.',
        };
      }
    }

    return {
      ok: true,
      paste: {
        ...summarize(row),
        content: String(row.content || ''),
      },
    };
  }

  list({ limit = 50, cursor = 0 } = {}) {
    this.deleteExpired();

    const normalizedLimit = Math.max(1, Math.min(Number(limit || 50), 200));
    const offset = Math.max(0, Number.parseInt(String(cursor || '0'), 10) || 0);
    const totalRow = get(this.db, 'SELECT COUNT(1) AS c FROM pastes');
    const rows = all(
      this.db,
      `SELECT * FROM pastes
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [normalizedLimit, offset]
    );

    const total = Number(totalRow?.c || 0);
    const nextOffset = offset + rows.length;

    return {
      items: rows.map(summarize),
      total,
      cursor: nextOffset < total ? String(nextOffset) : null,
      listComplete: nextOffset >= total,
    };
  }

  delete(id) {
    const pasteId = normalizePasteId(id);
    if (!pasteId) return false;
    const result = run(this.db, 'DELETE FROM pastes WHERE id = ?', [pasteId]);
    return Number(result.changes || 0) > 0;
  }

  deleteExpired() {
    run(this.db, 'DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?', [Date.now()]);
  }
}

module.exports = {
  PasteRepository,
};
