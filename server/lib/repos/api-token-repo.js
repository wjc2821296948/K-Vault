const crypto = require('node:crypto');
const { all, get, run } = require('../../db');

const TOKEN_PREFIX = 'kvault_';
const VALID_SCOPES = new Set(['upload', 'read', 'delete', 'paste']);
const TOKEN_ID_LENGTH = 12;
const TOKEN_SECRET_LENGTH = 40;
const TOKEN_SALT_LENGTH = 16;
const MASK_PREFIX = '******';

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += chars[bytes[i] % chars.length];
  }
  return output;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function hashTokenSecret(secret, salt) {
  return sha256Hex(`${salt}:${secret}`);
}

function sanitizeTokenId(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) return '';
  return value;
}

function splitToken(rawToken = '') {
  const value = String(rawToken || '').trim();
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_([A-Za-z0-9_-]{16,256})$/.exec(value);
  if (!match) return null;
  return {
    tokenId: match[1],
    secret: match[2],
    value,
  };
}

function normalizeExpiresAt(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? Math.max(0, Math.floor(rawValue)) : null;
  }
  const text = String(rawValue).trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.floor(numeric));
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(parsed));
  }
  return null;
}

function normalizeScopes(rawScopes = []) {
  const list = Array.isArray(rawScopes) ? rawScopes : [rawScopes];
  const normalized = [];
  list.forEach((item) => {
    const scope = String(item || '').trim().toLowerCase();
    if (!VALID_SCOPES.has(scope)) return;
    if (normalized.includes(scope)) return;
    normalized.push(scope);
  });
  return normalized;
}

function parseScopes(scopesJson) {
  try {
    return normalizeScopes(JSON.parse(scopesJson || '[]'));
  } catch {
    return [];
  }
}

function maskTokenSuffix(suffix = '') {
  return `${MASK_PREFIX}${String(suffix || '')}`;
}

function parseBearerToken(request) {
  const authorization = String(request.headers.get('Authorization') || '').trim();
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function getApiTokenScopes() {
  return [...VALID_SCOPES];
}

class ApiTokenRepository {
  constructor(db) {
    this.db = db;
  }

  toPublicRecord(record = {}) {
    return {
      id: record.id,
      name: record.name,
      scopes: Array.isArray(record.scopes) ? [...record.scopes] : [],
      expiresAt: record.expiresAt ?? null,
      createdAt: Number(record.createdAt || 0),
      lastUsedAt: record.lastUsedAt ?? null,
      enabled: Boolean(record.enabled),
      tokenPreview: record.tokenPreview || maskTokenSuffix(record.tokenSuffix || ''),
    };
  }

  rowToRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes_json),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at || 0),
      createdAt: Number(row.created_at || 0),
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at || 0),
      enabled: row.enabled !== 0,
      tokenSalt: row.token_salt,
      tokenHash: row.token_hash,
      tokenSuffix: row.token_suffix,
      tokenPreview: row.token_preview,
    };
  }

  getById(tokenId) {
    const id = sanitizeTokenId(tokenId);
    if (!id) return null;
    return this.rowToRecord(get(this.db, 'SELECT * FROM api_tokens WHERE id = ?', [id]));
  }

  generateUniqueTokenId(maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = randomString(TOKEN_ID_LENGTH);
      const exists = get(this.db, 'SELECT id FROM api_tokens WHERE id = ?', [candidate]);
      if (!exists) return candidate;
    }
    throw new Error('Failed to generate a unique token id.');
  }

  create({ name, scopes, expiresAt, enabled = true }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('Token name is required.');
    }

    const normalizedScopes = normalizeScopes(scopes);
    if (normalizedScopes.length === 0) {
      throw new Error('At least one valid scope is required.');
    }

    const tokenId = this.generateUniqueTokenId();
    const tokenSecret = randomString(TOKEN_SECRET_LENGTH);
    const tokenSalt = randomString(TOKEN_SALT_LENGTH);
    const tokenHash = hashTokenSecret(tokenSecret, tokenSalt);
    const tokenSuffix = tokenSecret.slice(-6);
    const tokenPreview = maskTokenSuffix(tokenSuffix);
    const now = Date.now();

    run(
      this.db,
      `INSERT INTO api_tokens(
        id, name, scopes_json, expires_at, created_at, last_used_at,
        enabled, token_salt, token_hash, token_suffix, token_preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tokenId,
        normalizedName,
        JSON.stringify(normalizedScopes),
        normalizeExpiresAt(expiresAt),
        now,
        null,
        enabled !== false ? 1 : 0,
        tokenSalt,
        tokenHash,
        tokenSuffix,
        tokenPreview,
      ]
    );

    const record = this.getById(tokenId);
    return {
      token: `${TOKEN_PREFIX}${tokenId}_${tokenSecret}`,
      record: this.toPublicRecord(record),
    };
  }

  list() {
    return all(this.db, 'SELECT * FROM api_tokens ORDER BY created_at DESC')
      .map((row) => this.toPublicRecord(this.rowToRecord(row)));
  }

  update(tokenId, patch = {}) {
    const current = this.getById(tokenId);
    if (!current) return null;

    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      next.enabled = Boolean(patch.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const normalizedName = String(patch.name || '').trim();
      if (!normalizedName) {
        throw new Error('Token name is required.');
      }
      next.name = normalizedName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'scopes')) {
      const normalizedScopes = normalizeScopes(patch.scopes);
      if (normalizedScopes.length === 0) {
        throw new Error('At least one valid scope is required.');
      }
      next.scopes = normalizedScopes;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
      next.expiresAt = normalizeExpiresAt(patch.expiresAt);
    }

    run(
      this.db,
      `UPDATE api_tokens
       SET name = ?, scopes_json = ?, expires_at = ?, enabled = ?
       WHERE id = ?`,
      [
        next.name,
        JSON.stringify(next.scopes),
        next.expiresAt,
        next.enabled ? 1 : 0,
        current.id,
      ]
    );

    return this.toPublicRecord(this.getById(current.id));
  }

  delete(tokenId) {
    const id = sanitizeTokenId(tokenId);
    if (!id) return false;
    const result = run(this.db, 'DELETE FROM api_tokens WHERE id = ?', [id]);
    return Number(result.changes || 0) > 0;
  }

  touchLastUsed(tokenId) {
    const id = sanitizeTokenId(tokenId);
    if (!id) return false;
    const result = run(this.db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [Date.now(), id]);
    return Number(result.changes || 0) > 0;
  }

  verify(tokenValue, requiredScope = '') {
    const split = splitToken(tokenValue);
    if (!split) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    const record = this.getById(split.tokenId);
    if (!record) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    const expectedHash = hashTokenSecret(split.secret, record.tokenSalt || '');
    if (!timingSafeEqualHex(expectedHash, String(record.tokenHash || ''))) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    if (!record.enabled) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_DISABLED',
        message: 'API Token is disabled.',
      };
    }

    if (Number.isFinite(record.expiresAt) && record.expiresAt > 0 && Date.now() > record.expiresAt) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_EXPIRED',
        message: 'API Token has expired.',
      };
    }

    const normalizedScope = String(requiredScope || '').trim().toLowerCase();
    if (normalizedScope && !record.scopes.includes(normalizedScope)) {
      return {
        ok: false,
        status: 403,
        code: 'TOKEN_SCOPE_DENIED',
        message: `API Token does not include "${normalizedScope}" scope.`,
      };
    }

    return {
      ok: true,
      token: this.toPublicRecord(record),
    };
  }
}

module.exports = {
  ApiTokenRepository,
  getApiTokenScopes,
  normalizeExpiresAt,
  parseBearerToken,
};
