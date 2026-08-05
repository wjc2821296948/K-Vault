const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Hono } = require('hono');
const { cors } = require('hono/cors');
const { createContainer } = require('./lib/container');
const { normalizeFolderPath } = require('./lib/repos/file-repo');
const {
  getApiTokenScopes,
  normalizeExpiresAt,
  parseBearerToken,
} = require('./lib/repos/api-token-repo');
const { toStorageErrorPayload } = require('./lib/utils/storage-error');
const { createShareSignature, verifyShareSignature } = require('./lib/utils/share-link');
const {
  getTelegramFileFromMessage,
  createSignedTelegramFileId,
  parseSignedTelegramFileId,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
  buildTelegramDirectLink,
  sendTelegramUploadNotice,
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  getFileLinkSecrets,
} = require('./lib/utils/telegram-webhook');

function createApp() {
  const app = new Hono();
  const container = createContainer(process.env);

  app.use('*', cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Range', 'X-KVault-Client', 'Accept'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition'],
    credentials: true,
  }));

  app.use('*', async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set('traceId', traceId);
    c.header('X-Trace-Id', traceId);
    c.set('container', container);
    try {
      await next();
    } catch (error) {
      console.error(error);
      const payload = toStorageErrorPayload(error, 500);
      const envelope = {
        success: false,
        error: {
          code: payload.code || 'INTERNAL_ERROR',
          message: payload.message || 'Internal Server Error',
          detail: payload.detail || String(error?.message || 'unknown'),
          retriable: payload.retriable === true,
        },
        traceId,
      };

      if (prefersV2Envelope(c)) {
        return c.json(envelope, 500);
      }

      return c.json({
        success: false,
        error: envelope.error.message,
        errorCode: envelope.error.code,
        errorDetail: envelope.error.detail,
        retriable: envelope.error.retriable,
        traceId,
      }, 500);
    }
  });

  function getServices(c) {
    return c.get('container');
  }

  function getTraceId(c) {
    return c.get('traceId') || crypto.randomUUID();
  }

  function prefersV2Envelope(c) {
    const client = String(c.req.header('X-KVault-Client') || '').toLowerCase();
    const accept = String(c.req.header('accept') || '').toLowerCase();
    return client === 'app-v2' || accept.includes('application/vnd.kvault.v2+json');
  }

  function jsonError(c, statusCode, code, message, detail, retriable = false, extra = {}) {
    const traceId = getTraceId(c);
    const errorInfo = {
      code: String(code || 'ERROR'),
      message: String(message || 'Request failed'),
      detail: String(detail || message || 'Request failed'),
      retriable: Boolean(retriable),
    };

    if (prefersV2Envelope(c)) {
      return c.json({
        success: false,
        error: errorInfo,
        traceId,
        ...extra,
      }, statusCode);
    }

    return c.json({
      success: false,
      error: errorInfo.message,
      errorCode: errorInfo.code,
      errorDetail: errorInfo.detail,
      retriable: errorInfo.retriable,
      traceId,
      ...extra,
    }, statusCode);
  }

  function asString(value, fallback = '') {
    if (value == null) return fallback;
    if (Array.isArray(value)) return asString(value[0], fallback);
    if (value instanceof File) return fallback;
    return String(value);
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        const nested = firstNonEmpty(...value);
        if (nested != null) return nested;
        continue;
      }
      if (value instanceof File) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
    return '';
  }

  function normalizeMoveIdentifier(value) {
    const raw = asString(value).trim();
    if (!raw) return '';
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return decoded
      .replace(/^https?:\/\/[^/]+\/file\//i, '')
      .replace(/^\/?file\//i, '')
      .trim();
  }

  function collectMoveIdentifiers(body = {}) {
    const values = [];
    if (Array.isArray(body.ids)) values.push(...body.ids);
    if (Array.isArray(body.files)) {
      for (const file of body.files) {
        if (!file || typeof file !== 'object') continue;
        values.push(
          file.id,
          file.name,
          file.key,
          file.fileId,
          file.fileName,
          file.metadata?.id,
          file.metadata?.fileId,
          file.metadata?.fileName
        );
      }
    }
    return Array.from(new Set(values.map(normalizeMoveIdentifier).filter(Boolean)));
  }

  function parseBoundedInt(value, fallback, min = 1, max = 1000) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function authResult(c) {
    const { authService } = getServices(c);
    return authService.checkAuthentication(c.req.raw);
  }

  function isTruthy(value) {
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }

  function requireAuth(c) {
    const result = authResult(c);
    if (!result.authenticated) {
      return jsonError(c, 401, 'UNAUTHORIZED', 'Authentication required.', result.reason || 'Unauthorized');
    }
    c.set('auth', result);
    return null;
  }

  function apiV1Success(payload = {}, status = 200, headers = {}) {
    return new Response(
      JSON.stringify({
        success: true,
        ...payload,
      }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        },
      }
    );
  }

  function apiV1Error(code, message, status = 400, extra = {}, headers = {}) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code,
          message,
          ...extra,
        },
      }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        },
      }
    );
  }

  function decodePathParam(rawValue = '') {
    try {
      return decodeURIComponent(String(rawValue || ''));
    } catch {
      return String(rawValue || '');
    }
  }

  function parsePositiveInt(rawValue, { defaultValue = 0, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(String(rawValue ?? ''), 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, min), max);
  }

  function normalizeExpiryInput(body = {}) {
    if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
      return normalizeExpiresAt(body.expiresAt);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expires_in')) {
      const seconds = parsePositiveInt(body.expires_in, { defaultValue: 0, min: 1, max: 3650 * 24 * 3600 });
      return seconds > 0 ? Date.now() + seconds * 1000 : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expiresIn')) {
      const seconds = parsePositiveInt(body.expiresIn, { defaultValue: 0, min: 1, max: 3650 * 24 * 3600 });
      return seconds > 0 ? Date.now() + seconds * 1000 : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expiresInDays')) {
      const days = parsePositiveInt(body.expiresInDays, { defaultValue: 0, min: 1, max: 3650 });
      return days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
    }
    return null;
  }

  function resolveApiV1RequiredScope(c) {
    const pathname = new URL(c.req.url).pathname.replace(/\/+$/, '');
    const method = String(c.req.method || 'GET').toUpperCase();

    const base = '/api/v1';
    if (!pathname.startsWith(base)) return '';
    const subPath = pathname.slice(base.length) || '/';

    if (method === 'POST' && subPath === '/upload') return 'upload';
    if (method === 'GET' && subPath === '/files') return 'read';
    if (method === 'GET' && /^\/file\/[^/]+$/.test(subPath)) return 'read';
    if (method === 'GET' && /^\/file\/[^/]+\/info$/.test(subPath)) return 'read';
    if (method === 'DELETE' && /^\/file\/[^/]+$/.test(subPath)) return 'delete';

    if (method === 'POST' && subPath === '/paste') return 'paste';
    if (method === 'GET' && subPath === '/pastes') return 'read';
    if (method === 'GET' && /^\/paste\/[^/]+$/.test(subPath)) return 'read';
    if (method === 'DELETE' && /^\/paste\/[^/]+$/.test(subPath)) return 'delete';

    return '';
  }

  function requireApiToken(c, requiredScope) {
    const { apiTokenRepo } = getServices(c);
    const scope = requiredScope || resolveApiV1RequiredScope(c);
    if (!scope) return null;

    const result = apiTokenRepo.verify(parseBearerToken(c.req.raw), scope);
    if (!result.ok) {
      return apiV1Error(
        result.code || 'TOKEN_INVALID',
        result.message || 'API Token is invalid.',
        result.status || 401
      );
    }

    c.set('apiToken', result.token);
    apiTokenRepo.touchLastUsed(result.token.id);
    return null;
  }

  function sanitizeSlug(rawValue = '') {
    const normalized = String(rawValue || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    return normalized.slice(0, 64);
  }

  function sha256Hex(input) {
    return crypto.createHash('sha256').update(String(input || '')).digest('hex');
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

  function timingSafeEqualText(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function normalizeMimeType(fileName = '', fallback = 'application/octet-stream') {
    const extension = String(fileName || '').split('.').pop()?.toLowerCase() || '';
    const map = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      m4a: 'audio/mp4',
      pdf: 'application/pdf',
      txt: 'text/plain',
      json: 'application/json',
      zip: 'application/zip',
    };
    return map[extension] || fallback;
  }

  function normalizeStorageName(file = {}) {
    return String(file.storage_type || file.metadata?.storageType || 'telegram').toLowerCase();
  }

  function mapV1File(file) {
    const metadata = file?.metadata || {};
    const fileName = file?.file_name || metadata.fileName || file?.id || '';
    const uploadTimestamp = Number(file?.created_at || metadata.TimeStamp || 0);
    return {
      id: file?.id || '',
      name: fileName,
      size: Number(file?.file_size || metadata.fileSize || 0),
      type: file?.mime_type || normalizeMimeType(fileName),
      storage: normalizeStorageName(file),
      uploadedAt: uploadTimestamp > 0 ? new Date(uploadTimestamp).toISOString() : null,
      folderPath: metadata.folderPath || '',
    };
  }

  function mapV1ListItem(item) {
    const metadata = item?.metadata || {};
    const fileName = metadata.fileName || item?.name || '';
    const uploadTimestamp = Number(metadata.TimeStamp || 0);
    return {
      id: item?.name || '',
      name: fileName,
      size: Number(metadata.fileSize || 0),
      type: metadata.mimeType || normalizeMimeType(fileName),
      storage: String(metadata.storageType || metadata.storage || 'telegram').toLowerCase(),
      uploadedAt: uploadTimestamp > 0 ? new Date(uploadTimestamp).toISOString() : null,
      folderPath: metadata.folderPath || '',
    };
  }

  function getSharePassword(c) {
    const url = new URL(c.req.url);
    return String(
      url.searchParams.get('password')
      || c.req.header('X-File-Password')
      || c.req.header('X-Share-Password')
      || ''
    );
  }

  function shareErrorResponse({ apiErrors, code, message, status }) {
    if (apiErrors) {
      return apiV1Error(code, message, status);
    }
    return new Response(message, { status });
  }

  function shouldCountAsDownload(c, response) {
    if (String(c.req.method || '').toUpperCase() !== 'GET') return false;
    if (!response) return false;
    return response.status === 200 || response.status === 206;
  }

  function verifyShareAccess(c, file, { apiErrors = false } = {}) {
    const metadata = file?.metadata || {};
    const expiresAt = Number(metadata.shareExpiresAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
      return {
        response: shareErrorResponse({
          apiErrors,
          code: 'FILE_LINK_EXPIRED',
          message: 'File link has expired',
          status: 410,
        }),
      };
    }

    const maxDownloads = Number(metadata.shareMaxDownloads || 0);
    const currentDownloads = Number(metadata.shareDownloadCount || 0);
    if (Number.isFinite(maxDownloads) && maxDownloads > 0 && currentDownloads >= maxDownloads) {
      return {
        response: shareErrorResponse({
          apiErrors,
          code: 'FILE_LINK_EXPIRED',
          message: 'File download limit reached',
          status: 410,
        }),
      };
    }

    if (metadata.sharePasswordHash) {
      const password = getSharePassword(c);
      if (!password) {
        return {
          response: shareErrorResponse({
            apiErrors,
            code: 'FILE_PASSWORD_REQUIRED',
            message: 'File password required',
            status: 401,
          }),
        };
      }

      const expected = sha256Hex(`${String(metadata.sharePasswordSalt || '')}:${password}`);
      if (!timingSafeEqualText(expected, metadata.sharePasswordHash)) {
        return {
          response: shareErrorResponse({
            apiErrors,
            code: 'FILE_ACCESS_DENIED',
            message: 'File password invalid',
            status: 403,
          }),
        };
      }
    }

    return {
      response: null,
      trackDownload: Number.isFinite(maxDownloads) && maxDownloads > 0,
    };
  }

  function incrementShareDownloadCount(fileRepo, file) {
    const current = Number(file?.metadata?.shareDownloadCount || 0);
    fileRepo.updateMetadata(file.id, {
      extra: {
        shareDownloadCount: current + 1,
      },
    });
  }

  function sanitizeSettingEntries(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }

    const output = {};
    for (const [rawKey, value] of Object.entries(input)) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      output[key] = value;
    }
    return output;
  }

  function getBootstrapReadiness(config) {
    const bootstrap = config?.bootstrapDefaultStorage || {};
    const byType = {
      telegram: Boolean(bootstrap.telegram?.botToken && bootstrap.telegram?.chatId),
      r2: Boolean(bootstrap.r2?.endpoint && bootstrap.r2?.bucket && bootstrap.r2?.accessKeyId && bootstrap.r2?.secretAccessKey),
      s3: Boolean(bootstrap.s3?.endpoint && bootstrap.s3?.bucket && bootstrap.s3?.accessKeyId && bootstrap.s3?.secretAccessKey),
      discord: Boolean(bootstrap.discord?.webhookUrl || (bootstrap.discord?.botToken && bootstrap.discord?.channelId)),
      huggingface: Boolean(bootstrap.huggingface?.token && bootstrap.huggingface?.repo),
      webdav: Boolean(bootstrap.webdav?.baseUrl && (bootstrap.webdav?.bearerToken || (bootstrap.webdav?.username && bootstrap.webdav?.password))),
      github: Boolean(bootstrap.github?.repo && bootstrap.github?.token),
    };

    return {
      defaultType: String(bootstrap.type || 'telegram').toLowerCase(),
      byType,
    };
  }

  const UI_CONFIG_FILE_NAME = 'ui_config.json';
  const UI_EFFECT_STYLES = new Set(['none', 'math', 'particle', 'texture']);
  const DEFAULT_UI_CONFIG = {
    version: 1,
    baseColor: '#fafaf8',
    globalBackgroundUrl: '',
    loginBackgroundMode: 'follow-global',
    loginBackgroundUrl: '',
    cardOpacity: 86,
    cardBlur: 14,
    effectStyle: 'math',
    effectIntensity: 22,
    optimizeMobile: true,
  };

  function clampUiNumber(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeUiHexColor(value) {
    const text = String(value || '').trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
      return DEFAULT_UI_CONFIG.baseColor;
    }
    if (text.length === 4) {
      return (
        '#' +
        text[1] +
        text[1] +
        text[2] +
        text[2] +
        text[3] +
        text[3]
      ).toLowerCase();
    }
    return text.toLowerCase();
  }

  function sanitizeUiUrl(url) {
    const text = String(url || '').trim();
    if (!text) return '';
    if (/^(https?:)?\/\//i.test(text)) return text;
    if (/^\//.test(text)) return text;
    return '';
  }

  function normalizeUiConfig(raw) {
    const next = Object.assign({}, DEFAULT_UI_CONFIG, raw || {});
    next.baseColor = normalizeUiHexColor(next.baseColor);
    next.globalBackgroundUrl = sanitizeUiUrl(next.globalBackgroundUrl);
    next.loginBackgroundMode = next.loginBackgroundMode === 'custom' ? 'custom' : 'follow-global';
    next.loginBackgroundUrl = sanitizeUiUrl(next.loginBackgroundUrl);
    next.cardOpacity = Math.round(clampUiNumber(next.cardOpacity, 0, 100));
    next.cardBlur = Math.round(clampUiNumber(next.cardBlur, 0, 32));
    next.effectStyle = UI_EFFECT_STYLES.has(next.effectStyle) ? next.effectStyle : DEFAULT_UI_CONFIG.effectStyle;
    next.effectIntensity = Math.round(clampUiNumber(next.effectIntensity, 0, 100));
    next.optimizeMobile = next.optimizeMobile !== false;
    return next;
  }

  function extractUiConfigPayload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }

    if (input.config && typeof input.config === 'object' && !Array.isArray(input.config)) {
      return input.config;
    }
    if (input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)) {
      return input.settings;
    }
    return input;
  }

  function resolveUiConfigPath() {
    const dir = container.config.dataDir || path.resolve(process.cwd(), 'data');
    return path.join(dir, UI_CONFIG_FILE_NAME);
  }

  async function readUiConfig() {
    const filePath = resolveUiConfigPath();
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeUiConfig(parsed);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return normalizeUiConfig(DEFAULT_UI_CONFIG);
      }
      console.warn('[ui-config] failed to read config, falling back to defaults:', error?.message || error);
      return normalizeUiConfig(DEFAULT_UI_CONFIG);
    }
  }

  async function writeUiConfig(input) {
    const filePath = resolveUiConfigPath();
    const normalized = normalizeUiConfig(input);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }

  function getSettingsKeyList(c) {
    const list = [];
    const rawSingle = c.req.query('key');
    const rawList = c.req.query('keys');

    if (rawSingle) {
      list.push(String(rawSingle));
    }
    if (rawList) {
      for (const key of String(rawList).split(',')) {
        list.push(key);
      }
    }

    return list
      .map((key) => String(key || '').trim())
      .filter(Boolean);
  }

  function normalizeUploadError(c, error, fallbackStatus = 500) {
    const payload = toStorageErrorPayload(error, error?.status || fallbackStatus);
    const detail = payload.detail || payload.message || '上传失败。';
    const message = payload.message || '上传失败。';
    const code = payload.code || 'UPLOAD_FAILED';
    const retriable = payload.retriable === true;

    if (prefersV2Envelope(c)) {
      return {
        success: false,
        error: {
          code,
          message,
          detail,
          retriable,
        },
      };
    }

    return {
      success: false,
      error: message,
      errorCode: code,
      errorDetail: detail,
      retriable,
    };
  }

  function getPublicOrigin(c) {
    const configured = String(container.config.publicBaseUrl || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const url = new URL(c.req.url);
    return `${url.protocol}//${url.host}`;
  }

  function toAbsoluteUrl(c, path) {
    return new URL(path, `${getPublicOrigin(c)}/`).toString();
  }

  function buildFileProxyHeaders(result, upstreamHeaders) {
    const headers = new Headers(upstreamHeaders);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    headers.set('Cache-Control', 'no-store, max-age=0');

    if (!headers.get('content-type') && result.file.mime_type) {
      headers.set('Content-Type', result.file.mime_type);
    }
    if (!headers.get('content-disposition')) {
      const safeName = encodeURIComponent(result.file.file_name || result.file.id);
      headers.set('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`);
    }

    return headers;
  }

  async function handleSignedTelegramFile(id, range, storageRepo, c, headOnly = false) {
    const env = { ...process.env, FILE_URL_SECRET: container.config.configEncryptionKey };
    const parsed = parseSignedTelegramFileId(id, env);
    if (!parsed?.fileId) {
      return c.text('Invalid or expired signed file link.', 403);
    }

    // Resolve Telegram storage config
    const telegramConfigs = storageRepo.findEnabledByType('telegram');
    let tgConfig = telegramConfigs[0]?.config;
    if (!tgConfig?.botToken) {
      const bootstrap = container.config.bootstrapDefaultStorage?.telegram;
      if (bootstrap?.botToken) tgConfig = bootstrap;
    }
    if (!tgConfig?.botToken) {
      return c.text('Telegram 存储未配置。', 500);
    }

    const { TelegramStorageAdapter } = require('./lib/storage/adapters/telegram');
    const adapter = new TelegramStorageAdapter({
      botToken: tgConfig.botToken,
      chatId: tgConfig.chatId,
      apiBase: tgConfig.apiBase || container.config.telegramApiBase,
    });

    const upstream = await adapter.download({
      storageKey: parsed.fileId,
      metadata: { telegramFileId: parsed.fileId },
      range,
    });

    if (!upstream) {
      return c.text('Telegram 中未找到该文件。', 404);
    }

    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    headers.set('Cache-Control', 'no-store, max-age=0');
    if (!headers.get('content-type') && parsed.mimeType) {
      headers.set('Content-Type', parsed.mimeType);
    }
    if (!headers.get('content-disposition')) {
      const safeName = encodeURIComponent(parsed.fileName || `${parsed.fileId}.${parsed.fileExtension}`);
      headers.set('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`);
    }

    if (headOnly) {
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  function parseShareExpiry(value, fallbackSeconds = 7 * 24 * 60 * 60) {
    const seconds = parseBoundedInt(value, fallbackSeconds, 60, 365 * 24 * 60 * 60);
    return Date.now() + (seconds * 1000);
  }

  function formatStatusDetail(detail) {
    if (detail == null) return '';
    if (typeof detail === 'string') return detail;
    if (detail instanceof Error) return detail.message || String(detail);
    if (typeof detail === 'object') {
      if (typeof detail.description === 'string' && detail.description) return detail.description;
      if (typeof detail.message === 'string' && detail.message) return detail.message;
      if (typeof detail.error === 'string' && detail.error) return detail.error;
      try {
        return JSON.stringify(detail);
      } catch {
        return String(detail);
      }
    }
    return String(detail);
  }

  function getUploadLimits() {
    const mb = 1024 * 1024;
    const directThreshold = Number(container.config.uploadSmallFileThreshold || 20 * mb);
    const maxUploadSize = Number(container.config.uploadMaxSize || 100 * mb);

    return {
      telegram: {
        maxBytes: Math.min(maxUploadSize, 50 * mb),
        directThreshold,
        supportsChunkUpload: true,
        message: 'Docker 运行时的 Telegram Bot API 上传上限为 50MB。较大的文件请使用 R2、S3、WebDAV、GitHub，或通过 Telegram 客户端上传后使用 Webhook 回链。',
      },
      r2: {
        maxBytes: maxUploadSize,
        directThreshold,
        supportsChunkUpload: true,
      },
      s3: {
        maxBytes: maxUploadSize,
        directThreshold,
        supportsChunkUpload: true,
      },
      discord: {
        maxBytes: Math.min(maxUploadSize, 25 * mb),
        directThreshold,
        supportsChunkUpload: true,
        message: 'Discord 上传上限受服务器加成影响，K-Vault 默认按 25MB 保守处理。',
      },
      huggingface: {
        maxBytes: Math.min(maxUploadSize, 35 * mb),
        directThreshold,
        supportsChunkUpload: true,
      },
      webdav: {
        maxBytes: maxUploadSize,
        directThreshold,
        supportsChunkUpload: true,
      },
      github: {
        maxBytes: maxUploadSize,
        directThreshold,
        supportsChunkUpload: true,
      },
    };
  }

  function normalizeTelegramReplyResult(result, chatId) {
    if (!chatId) {
      return {
        attempted: false,
        ok: false,
        skipped: true,
        reason: 'missing-chat-id',
      };
    }

    if (!result) {
      return {
        attempted: true,
        ok: false,
        skipped: false,
        reason: 'empty-result',
      };
    }

    return {
      attempted: !result.skipped,
      ok: Boolean(result.ok),
      skipped: Boolean(result.skipped),
      reason: result.reason || result.error || result.data?.description || '',
      status: result.data?.error_code || undefined,
    };
  }

  function uploadSuccessResponse(c, result) {
    const item = {
      src: result.src,
      storageType: result.storage.type,
      storageId: result.storage.id,
      fileId: result.file?.id,
      folderPath: result.file?.metadata?.folderPath || '',
    };

    if (prefersV2Envelope(c)) {
      return c.json({
        success: true,
        data: {
          ...item,
          items: [item],
        },
        traceId: getTraceId(c),
      });
    }

    return c.json([item]);
  }

  // --- Auth ---
  app.get('/api/auth/check', (c) => {
    const { authService, guestService } = getServices(c);
    const auth = authService.checkAuthentication(c.req.raw);

    return c.json({
      authenticated: auth.authenticated,
      authRequired: authService.isAuthRequired(),
      reason: auth.reason,
      guestUpload: guestService.getConfig(),
    });
  });

  app.post('/api/auth/login', async (c) => {
    const { authService } = getServices(c);

    if (!authService.isAuthRequired()) {
      return c.json({ success: true, authRequired: false, message: 'No login required.' });
    }

    const body = await c.req.json().catch(() => ({}));
    const username = firstNonEmpty(body.username, body.user);
    const password = String(body.password ?? body.pass ?? '');

    if (!username || password === '') {
      return jsonError(
        c,
        400,
        'MISSING_CREDENTIALS',
        'Missing username or password.',
        'Provide both username and password.'
      );
    }

    if (username !== container.config.basicUser || password !== container.config.basicPass) {
      return jsonError(
        c,
        401,
        'INVALID_CREDENTIALS',
        'Invalid username or password.',
        'Credential verification failed.'
      );
    }

    const session = authService.createSession(username);
    c.header('Set-Cookie', authService.createSessionCookie(session.token));

    return c.json({ success: true, message: 'Login successful.' });
  });

  app.post('/api/auth/logout', (c) => {
    const { authService } = getServices(c);
    const token = authService.getSessionTokenFromRequest(c.req.raw);
    authService.deleteSession(token);

    const clearCookies = authService.createClearSessionCookies();
    const response = c.json({ success: true, message: 'Logged out.' });
    response.headers.append('Set-Cookie', clearCookies[0]);
    response.headers.append('Set-Cookie', clearCookies[1]);
    return response;
  });

  app.get('/api/auth/login', (c) => {
    const { authService } = getServices(c);
    return c.json({
      authRequired: authService.isAuthRequired(),
    });
  });

  // Compatibility aliases
  app.get('/api/manage/check', (c) => {
    const { authService } = getServices(c);
    return c.text(authService.isAuthRequired() ? 'true' : 'Not using basic auth.');
  });

  app.get('/api/manage/login', (c) => {
    const auth = authResult(c);
    if (auth.authenticated) {
      return c.redirect('/admin.html', 302);
    }
    return c.redirect('/login.html?redirect=%2Fadmin.html', 302);
  });

  const handleManageLogout = (c) => {
    const { authService } = getServices(c);
    const token = authService.getSessionTokenFromRequest(c.req.raw);
    authService.deleteSession(token);
    const clearCookies = authService.createClearSessionCookies();
    const response = c.redirect('/login.html', 302);
    response.headers.append('Set-Cookie', clearCookies[0]);
    response.headers.append('Set-Cookie', clearCookies[1]);
    return response;
  };
  app.get('/api/manage/logout', handleManageLogout);
  app.post('/api/manage/logout', handleManageLogout);

  // --- Admin API Token management ---
  app.get('/api/admin/tokens', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { apiTokenRepo } = getServices(c);
    return apiV1Success({
      tokens: apiTokenRepo.list(),
      scopes: getApiTokenScopes(),
    });
  });

  app.post('/api/admin/tokens', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { apiTokenRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name || body?.remark || '').trim();
    if (!name) {
      return apiV1Error('VALIDATION_ERROR', 'Token name is required.', 400);
    }

    try {
      const created = apiTokenRepo.create({
        name,
        scopes: body?.scopes || [],
        expiresAt: normalizeExpiryInput(body),
        enabled: body?.enabled !== false,
      });

      return apiV1Success({
        token: created.token,
        tokenInfo: created.record,
      }, 201);
    } catch (error) {
      return apiV1Error('TOKEN_CREATE_FAILED', error.message || 'Failed to create API Token.', 400);
    }
  });

  app.patch('/api/admin/tokens/:id', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const tokenId = decodePathParam(c.req.param('id'));
    if (!tokenId) {
      return apiV1Error('VALIDATION_ERROR', 'Token id is required.', 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      patch.enabled = body.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      patch.name = body.name;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'scopes')) {
      patch.scopes = body.scopes;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
      patch.expiresAt = normalizeExpiresAt(body.expiresAt);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expires_in')) {
      const seconds = Number.parseInt(String(body.expires_in), 10);
      patch.expiresAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null;
    }

    if (Object.keys(patch).length === 0) {
      return apiV1Error('VALIDATION_ERROR', 'No token fields provided to update.', 400);
    }

    try {
      const { apiTokenRepo } = getServices(c);
      const token = apiTokenRepo.update(tokenId, patch);
      if (!token) {
        return apiV1Error('TOKEN_NOT_FOUND', 'API Token not found.', 404);
      }
      return apiV1Success({ token });
    } catch (error) {
      return apiV1Error('TOKEN_UPDATE_FAILED', error.message || 'Failed to update API Token.', 400);
    }
  });

  app.delete('/api/admin/tokens/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const tokenId = decodePathParam(c.req.param('id'));
    if (!tokenId) {
      return apiV1Error('VALIDATION_ERROR', 'Token id is required.', 400);
    }

    const { apiTokenRepo } = getServices(c);
    if (!apiTokenRepo.delete(tokenId)) {
      return apiV1Error('TOKEN_NOT_FOUND', 'API Token not found.', 404);
    }
    return apiV1Success({ deleted: true });
  });

  app.use('/api/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return next();
    }
    const unauthorized = requireApiToken(c);
    if (unauthorized) return unauthorized;
    return next();
  });

  app.post('/api/v1/upload', async (c) => {
    const { uploadService, fileRepo } = getServices(c);

    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return apiV1Error('BAD_REQUEST', 'Request must use multipart/form-data.', 400);
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return apiV1Error('VALIDATION_ERROR', 'Field "file" is required.', 400);
    }

    const fileBuffer = await file.arrayBuffer();
    const fileSize = fileBuffer.byteLength;
    if (fileSize > container.config.uploadMaxSize) {
      return apiV1Error('FILE_TOO_LARGE', 'File exceeds upload size limit.', 413);
    }

    const url = new URL(c.req.url);
    const storage = String(body.storage || url.searchParams.get('storage') || '').trim().toLowerCase();
    const storageMode = storage || asString(body.storageMode || body.storage_mode);
    const storageModeForLimit = storageMode || container.config.bootstrapDefaultStorage?.type || 'telegram';
    const uploadLimit = getUploadLimits()[storageModeForLimit];
    if (uploadLimit && fileSize > uploadLimit.maxBytes) {
      return apiV1Error(
        'FILE_TOO_LARGE',
        uploadLimit.message || 'File exceeds selected storage limit.',
        413
      );
    }

    const rawSlug = String(body.slug || url.searchParams.get('slug') || '');
    const slug = sanitizeSlug(rawSlug);
    if (rawSlug && !slug) {
      return apiV1Error('VALIDATION_ERROR', 'Field "slug" can only contain letters, numbers, underscores or hyphens.', 400);
    }

    let result;
    try {
      result = await uploadService.uploadFile({
        fileName: file.name,
        mimeType: file.type || normalizeMimeType(file.name),
        fileSize,
        buffer: fileBuffer,
        storageMode,
        storageId: asString(body.storageId || body.storage_config_id),
        folderPath: normalizeFolderPath(body.folderPath || body.folder || ''),
      });
    } catch (error) {
      const payload = toStorageErrorPayload(error, error?.status || 502);
      const status = payload.code === 'FILE_TOO_LARGE' ? 413 : 502;
      return apiV1Error(
        status === 413 ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
        payload.message || error?.message || 'Upload failed.',
        status
      );
    }

    let fileRecord = result.file;
    const extra = {};
    const expiresIn = parsePositiveInt(
      body.expires_in || body.expiresIn || url.searchParams.get('expires_in'),
      { defaultValue: 0, min: 1, max: 3650 * 24 * 3600 }
    );
    if (expiresIn > 0) {
      extra.shareExpiresAt = Date.now() + expiresIn * 1000;
    }

    const maxDownloads = parsePositiveInt(
      body.max_downloads || body.maxDownloads || url.searchParams.get('max_downloads'),
      { defaultValue: 0, min: 1, max: 1000000000 }
    );
    if (maxDownloads > 0) {
      extra.shareMaxDownloads = maxDownloads;
      extra.shareDownloadCount = 0;
    }

    if (slug) {
      const existing = fileRepo.findByShareSlug(slug);
      if (existing && existing.id !== fileRecord.id) {
        await uploadService.deleteFile(fileRecord.id).catch(() => {});
        return apiV1Error('SLUG_CONFLICT', 'Custom share slug is already in use.', 409);
      }
      extra.shareSlug = slug;
    }

    const password = String(body.password || url.searchParams.get('password') || '');
    if (password) {
      const salt = randomString(12);
      extra.sharePasswordSalt = salt;
      extra.sharePasswordHash = sha256Hex(`${salt}:${password}`);
    }

    if (Object.keys(extra).length > 0) {
      fileRecord = fileRepo.updateMetadata(fileRecord.id, { extra }) || fileRecord;
    }

    const shareId = sanitizeSlug(fileRecord.metadata?.shareSlug || '') || fileRecord.id;

    return apiV1Success({
      file: mapV1File(fileRecord),
      links: {
        download: toAbsoluteUrl(c, `/file/${encodeURIComponent(fileRecord.id)}`),
        share: toAbsoluteUrl(c, `/s/${encodeURIComponent(shareId)}`),
        delete: toAbsoluteUrl(c, `/api/v1/file/${encodeURIComponent(fileRecord.id)}`),
      },
    });
  });

  app.get('/api/v1/files', (c) => {
    const { fileRepo } = getServices(c);
    const limit = parsePositiveInt(c.req.query('limit'), { defaultValue: 50, min: 1, max: 200 });
    const cursor = c.req.query('cursor') || c.req.query('offset') || '0';
    const filters = {
      storageType: c.req.query('storage') || 'all',
      search: c.req.query('search') || '',
      listType: c.req.query('listType') || c.req.query('list_type') || 'all',
    };
    if (c.req.query('folderPath') != null || c.req.query('path') != null) {
      filters.folderPath = normalizeFolderPath(c.req.query('folderPath') || c.req.query('path') || '');
    }

    const payload = fileRepo.list({
      limit,
      cursor,
      includeStats: true,
      filters,
    });

    return apiV1Success({
      files: (payload.keys || []).map(mapV1ListItem),
      pagination: {
        cursor: payload.cursor || null,
        listComplete: Boolean(payload.list_complete),
        pageCount: Number(payload.pageCount || 0),
        total: Number(payload.stats?.total || payload.pageCount || 0),
      },
    });
  });

  app.get('/api/v1/file/:id/info', (c) => {
    const { fileRepo } = getServices(c);
    const fileId = decodePathParam(c.req.param('id'));
    if (!fileId) {
      return apiV1Error('VALIDATION_ERROR', 'File id is required.', 400);
    }

    const file = fileRepo.getById(fileId);
    if (!file) {
      return apiV1Error('FILE_NOT_FOUND', 'File not found.', 404);
    }

    return apiV1Success({
      file: {
        ...mapV1File(file),
        raw: {
          success: true,
          fileId: file.id,
          key: file.id,
          fileName: file.file_name,
          originalName: file.file_name,
          fileSize: file.file_size,
          uploadTime: file.created_at,
          storageType: file.storage_type,
          listType: file.list_type,
          label: file.label,
          liked: Boolean(file.liked),
          folderPath: file.metadata?.folderPath || '',
        },
      },
    });
  });

  app.get('/api/v1/file/:id', async (c) => {
    const { uploadService, fileRepo } = getServices(c);
    const fileId = decodePathParam(c.req.param('id'));
    if (!fileId) {
      return apiV1Error('VALIDATION_ERROR', 'File id is required.', 400);
    }

    const file = fileRepo.getById(fileId);
    if (!file) {
      return apiV1Error('FILE_NOT_FOUND', 'File not found.', 404);
    }

    const shareAccess = verifyShareAccess(c, file, { apiErrors: true });
    if (shareAccess.response) return shareAccess.response;

    try {
      const result = await uploadService.getFileResponse(fileId, c.req.header('range'));
      if (!result) {
        return apiV1Error('FILE_NOT_FOUND', 'File not found.', 404);
      }

      const upstream = result.response;
      const headers = buildFileProxyHeaders(result, upstream.headers);
      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });

      if (shareAccess.trackDownload && shouldCountAsDownload(c, response)) {
        incrementShareDownloadCount(fileRepo, file);
      }

      return response;
    } catch (error) {
      return apiV1Error('FILE_READ_FAILED', error?.message || 'Failed to read file.', 502);
    }
  });

  app.delete('/api/v1/file/:id', async (c) => {
    const { uploadService } = getServices(c);
    const fileId = decodePathParam(c.req.param('id'));
    if (!fileId) {
      return apiV1Error('VALIDATION_ERROR', 'File id is required.', 400);
    }

    const result = await uploadService.deleteFile(fileId);
    if (!result.deleted) {
      return apiV1Error('FILE_NOT_FOUND', 'File not found.', 404);
    }

    return apiV1Success({
      deleted: true,
      fileId,
      message: 'File deleted.',
    });
  });

  app.post('/api/v1/paste', async (c) => {
    const { pasteRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const content = String(body?.content || '');
    if (!content.trim()) {
      return apiV1Error('VALIDATION_ERROR', 'Field "content" is required.', 400);
    }

    const expiresIn = parsePositiveInt(body?.expires_in ?? body?.expiresIn, {
      defaultValue: 0,
      min: 1,
      max: 3650 * 24 * 3600,
    });

    try {
      const paste = pasteRepo.create({
        content,
        language: body?.language || 'text',
        expiresIn: expiresIn > 0 ? expiresIn : null,
        password: body?.password || '',
      });

      return apiV1Success({
        paste: {
          id: paste.id,
          language: paste.language,
          createdAt: new Date(Number(paste.createdAt || Date.now())).toISOString(),
          expiresAt: paste.expiresAt ? new Date(Number(paste.expiresAt)).toISOString() : null,
          hasPassword: paste.hasPassword,
        },
        links: {
          view: toAbsoluteUrl(c, `/api/v1/paste/${encodeURIComponent(paste.id)}`),
          raw: toAbsoluteUrl(c, `/api/v1/paste/${encodeURIComponent(paste.id)}`),
        },
      }, 201);
    } catch (error) {
      return apiV1Error('PASTE_CREATE_FAILED', error.message || 'Failed to create paste.', 400);
    }
  });

  app.get('/api/v1/pastes', (c) => {
    const { pasteRepo } = getServices(c);
    const limit = parsePositiveInt(c.req.query('limit'), { defaultValue: 50, min: 1, max: 200 });
    const cursor = parsePositiveInt(c.req.query('cursor'), {
      defaultValue: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    const result = pasteRepo.list({ limit, cursor });

    return apiV1Success({
      pastes: (result.items || []).map((item) => ({
        id: item.id,
        language: item.language,
        createdAt: item.createdAt ? new Date(Number(item.createdAt)).toISOString() : null,
        expiresAt: item.expiresAt ? new Date(Number(item.expiresAt)).toISOString() : null,
        hasPassword: Boolean(item.hasPassword),
        size: Number(item.size || 0),
      })),
      pagination: {
        cursor: result.cursor || null,
        listComplete: Boolean(result.listComplete),
        total: Number(result.total || 0),
      },
    });
  });

  app.get('/api/v1/paste/:id', (c) => {
    const { pasteRepo } = getServices(c);
    const pasteId = decodePathParam(c.req.param('id'));
    if (!pasteId) {
      return apiV1Error('VALIDATION_ERROR', 'Paste id is required.', 400);
    }

    const password =
      c.req.query('password')
      || c.req.header('X-Paste-Password')
      || '';
    const result = pasteRepo.getById(pasteId, { password });
    if (!result.ok) {
      return apiV1Error(
        result.code || 'PASTE_READ_FAILED',
        result.message || 'Failed to read paste.',
        result.status || 400
      );
    }

    return apiV1Success({
      paste: {
        id: result.paste.id,
        content: result.paste.content,
        language: result.paste.language,
        createdAt: result.paste.createdAt ? new Date(Number(result.paste.createdAt)).toISOString() : null,
        expiresAt: result.paste.expiresAt ? new Date(Number(result.paste.expiresAt)).toISOString() : null,
        hasPassword: Boolean(result.paste.hasPassword),
        size: Number(result.paste.size || 0),
      },
    });
  });

  app.delete('/api/v1/paste/:id', (c) => {
    const { pasteRepo } = getServices(c);
    const pasteId = decodePathParam(c.req.param('id'));
    if (!pasteId) {
      return apiV1Error('VALIDATION_ERROR', 'Paste id is required.', 400);
    }

    if (!pasteRepo.delete(pasteId)) {
      return apiV1Error('PASTE_NOT_FOUND', 'Paste not found.', 404);
    }

    return apiV1Success({
      deleted: true,
      pasteId,
    });
  });

  const getSettingsHandler = async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { settingsStore } = getServices(c);
    const keys = getSettingsKeyList(c);
    const settings = keys.length > 0
      ? await settingsStore.getMany(keys)
      : await settingsStore.getAll();

    return c.json({ success: true, settings });
  };

  const setSettingsHandler = async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { settingsStore } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const source = body.settings != null ? body.settings : body;
    const settings = sanitizeSettingEntries(source);
    const removeKeys = Array.isArray(body.removeKeys)
      ? body.removeKeys.map((key) => String(key || '').trim()).filter(Boolean)
      : [];

    if (Object.keys(settings).length > 0) {
      await settingsStore.setMany(settings);
    }
    if (removeKeys.length > 0) {
      await settingsStore.deleteMany(removeKeys);
    }

    return c.json({
      success: true,
      settings: await settingsStore.getAll(),
    });
  };

  const deleteSettingsHandler = async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { settingsStore } = getServices(c);
    const queryKeys = getSettingsKeyList(c);
    let payloadKeys = [];

    if (queryKeys.length === 0) {
      const body = await c.req.json().catch(() => ({}));
      if (Array.isArray(body.keys)) {
        payloadKeys = body.keys.map((key) => String(key || '').trim()).filter(Boolean);
      }
    }

    const keys = queryKeys.length > 0 ? queryKeys : payloadKeys;
    if (keys.length === 0) {
      return jsonError(
        c,
        400,
        'NO_SETTING_KEYS',
        'No setting keys provided.',
        'Provide key or keys in query/body.'
      );
    }

    await settingsStore.deleteMany(keys);

    return c.json({
      success: true,
      settings: await settingsStore.getAll(),
    });
  };

  app.get('/api/settings', getSettingsHandler);
  app.put('/api/settings', setSettingsHandler);
  app.patch('/api/settings', setSettingsHandler);
  app.delete('/api/settings', deleteSettingsHandler);

  // Compatibility aliases
  app.get('/api/manage/settings', getSettingsHandler);
  app.post('/api/manage/settings', setSettingsHandler);

  app.get('/api/ui-config', async (c) => {
    const config = await readUiConfig();
    return c.json({
      success: true,
      config,
      source: 'file',
    });
  });

  app.post('/api/ui-config', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const body = await c.req.json().catch(() => ({}));
    const config = await writeUiConfig(extractUiConfigPayload(body));

    return c.json({
      success: true,
      config,
      source: 'file',
    });
  });

  // --- Storage configs ---
  app.get('/api/storage/list', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    return c.json({ success: true, items: storageRepo.list(false) });
  });

  app.post('/api/storage', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    const body = await c.req.json();

    const created = storageRepo.create({
      name: body.name,
      type: body.type,
      config: body.config || {},
      enabled: body.enabled !== false,
      isDefault: Boolean(body.isDefault),
      metadata: body.metadata || {},
    });

    return c.json({ success: true, item: storageRepo.getById(created.id, false) });
  });

  app.put('/api/storage/:id', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    const id = c.req.param('id');
    const body = await c.req.json();

    const updated = storageRepo.update(id, {
      name: body.name,
      type: body.type,
      config: body.config,
      enabled: body.enabled,
      isDefault: body.isDefault,
      metadata: body.metadata,
    });

    if (!updated) {
      return jsonError(c, 404, 'STORAGE_NOT_FOUND', 'Storage config not found.', `Storage config "${id}" does not exist.`);
    }

    return c.json({ success: true, item: storageRepo.getById(id, false) });
  });

  app.delete('/api/storage/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    const id = c.req.param('id');
    let deleted = false;
    try {
      deleted = storageRepo.delete(id);
    } catch (error) {
      return jsonError(
        c,
        409,
        'STORAGE_CONFLICT',
        'Storage config cannot be deleted.',
        error?.message || 'Storage profile is in use.'
      );
    }

    if (!deleted) {
      return jsonError(c, 404, 'STORAGE_NOT_FOUND', 'Storage config not found.', `Storage config "${id}" does not exist.`);
    }
    return c.json({ success: true });
  });

  app.post('/api/storage/:id/test', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo, storageFactory } = getServices(c);
    const id = c.req.param('id');
    const item = storageRepo.getById(id, true);
    if (!item) {
      return jsonError(c, 404, 'STORAGE_NOT_FOUND', 'Storage config not found.', `Storage config "${id}" does not exist.`);
    }

    try {
      const adapter = storageFactory.createAdapter(item);
      const result = await adapter.testConnection();
      const normalized = {
        ...(result || {}),
      };
      if (!normalized.connected) {
        normalized.detail = formatStatusDetail(normalized.detail || normalized.raw || 'Connection failed');
        normalized.errorModel = toStorageErrorPayload(normalized.detail || 'Connection failed', normalized.status);
      }
      return c.json({ success: true, result: normalized });
    } catch (error) {
      const payload = toStorageErrorPayload(error);
      return c.json({ success: true, result: { connected: false, errorModel: payload, detail: payload.detail } });
    }
  });

  app.post('/api/storage/bootstrap/sync', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    storageRepo.ensureBootstrapStorage();

    const items = storageRepo.list(false);
    return c.json({
      success: true,
      synced: true,
      bootstrap: getBootstrapReadiness(container.config),
      items,
    });
  });

  app.post('/api/storage/default/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageRepo } = getServices(c);
    const id = c.req.param('id');
    const item = storageRepo.setDefault(id);
    if (!item) {
      return jsonError(c, 404, 'STORAGE_NOT_FOUND', 'Storage config not found.', `Storage config "${id}" does not exist.`);
    }

    return c.json({ success: true, item: storageRepo.getById(id, false) });
  });

  app.post('/api/storage/test', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { storageFactory } = getServices(c);
    const body = await c.req.json();
    try {
      const adapter = storageFactory.createTemporaryAdapter(body.type, body.config || {});
      const result = await adapter.testConnection();
      const normalized = {
        ...(result || {}),
      };
      if (!normalized.connected) {
        normalized.detail = formatStatusDetail(normalized.detail || normalized.raw || 'Connection failed');
        normalized.errorModel = toStorageErrorPayload(normalized.detail || 'Connection failed', normalized.status);
      }
      return c.json({ success: true, result: normalized });
    } catch (error) {
      const payload = toStorageErrorPayload(error);
      return c.json({ success: true, result: { connected: false, errorModel: payload, detail: payload.detail } });
    }
  });

  // --- Status ---
  app.get('/api/status', async (c) => {
    const { storageRepo, storageFactory, authService, guestService, settingsStore } = getServices(c);

    const status = {
      telegram: {
        connected: false,
        enabled: false,
        configured: false,
        layer: 'direct',
        message: 'Not configured',
      },
      kv: { connected: true, message: 'SQLite metadata storage enabled' },
      r2: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
      s3: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
      discord: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
      huggingface: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
      webdav: { connected: false, enabled: false, configured: false, layer: 'mounted', message: 'Not configured' },
      github: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
      auth: {
        enabled: authService.isAuthRequired(),
        message: authService.isAuthRequired() ? 'Password auth enabled' : 'No auth required',
      },
      guestUpload: guestService.getConfig(),
      uploadLimits: getUploadLimits(),
      settings: { connected: false, message: 'Unknown' },
      diagnostics: {},
    };

    status.settings = await settingsStore.healthCheck();

    const configs = storageRepo.list(true);
    const byType = {
      telegram: configs.find((item) => item.type === 'telegram') || null,
      r2: configs.find((item) => item.type === 'r2') || null,
      s3: configs.find((item) => item.type === 's3') || null,
      discord: configs.find((item) => item.type === 'discord') || null,
      huggingface: configs.find((item) => item.type === 'huggingface') || null,
      webdav: configs.find((item) => item.type === 'webdav') || null,
      github: configs.find((item) => item.type === 'github') || null,
    };

    for (const [type, storageConfig] of Object.entries(byType)) {
      if (!storageConfig) continue;
      if (!storageConfig.enabled) {
        status[type] = {
          connected: false,
          enabled: false,
          configured: true,
          layer: status[type]?.layer || 'direct',
          message: `Configured (${storageConfig.name}) but disabled`,
          configName: storageConfig.name,
        };
        continue;
      }
      try {
        const adapter = storageFactory.createAdapter(storageConfig);
        const result = await adapter.testConnection();
        const detailText = formatStatusDetail(result.detail || result.raw || '');
        const errorModel = result.connected
          ? undefined
          : toStorageErrorPayload(detailText || 'Connection failed', result.status);

        status[type] = {
          connected: Boolean(result.connected),
          enabled: Boolean(storageConfig.enabled),
          configured: true,
          layer: status[type]?.layer || 'direct',
          message: result.connected
            ? `Connected (${storageConfig.name})`
            : (detailText ? `Connection failed: ${detailText}` : 'Connection failed'),
          errorModel,
          configName: storageConfig.name,
        };
      } catch (error) {
        const errorModel = toStorageErrorPayload(error);
        status[type] = {
          connected: false,
          enabled: Boolean(storageConfig.enabled),
          configured: true,
          layer: status[type]?.layer || 'direct',
          message: `Connection error: ${errorModel.detail}`,
          errorModel,
          configName: storageConfig.name,
        };
      }
    }

    const telegramConfig = byType.telegram;
    if (telegramConfig) {
      const envSource = telegramConfig.metadata?.envSource
        || container.config.bootstrapDefaultStorage?.telegram?.envSource
        || {};
      const hasToken = Boolean(telegramConfig.config?.botToken);
      const hasChatId = Boolean(telegramConfig.config?.chatId);
      const telegramStatus = status.telegram || {};
      status.diagnostics.telegram = {
        summary: telegramStatus.connected
          ? 'Telegram adapter is connected.'
          : (telegramStatus.message || 'Telegram adapter is unavailable.'),
        configName: telegramConfig.name || '',
        configSource: telegramConfig.metadata?.source || 'dynamic-storage-config',
        tokenSource: envSource.botToken || 'configured in storage profile',
        chatIdSource: envSource.chatId || 'configured in storage profile',
        apiBaseSource: envSource.apiBase || 'configured in storage profile',
        hasToken,
        hasChatId,
      };
    } else {
      const envSource = container.config.bootstrapDefaultStorage?.telegram?.envSource || {};
      const hasToken = Boolean(container.config.bootstrapDefaultStorage?.telegram?.botToken);
      const hasChatId = Boolean(container.config.bootstrapDefaultStorage?.telegram?.chatId);
      status.diagnostics.telegram = {
        summary: 'Telegram storage profile is not created yet.',
        configName: '',
        configSource: 'not-configured',
        tokenSource: envSource.botToken || 'not found',
        chatIdSource: envSource.chatId || 'not found',
        apiBaseSource: envSource.apiBase || 'default',
        hasToken,
        hasChatId,
      };
    }

    status.capabilities = [
      { type: 'telegram', label: 'Telegram', layer: 'direct', enableHint: 'Create a Telegram storage profile in Storage Config.' },
      { type: 'r2', label: 'Cloudflare R2', layer: 'direct', enableHint: 'Create an R2 profile with endpoint/bucket/keys.' },
      { type: 's3', label: 'S3 Compatible', layer: 'direct', enableHint: 'Create an S3 profile with endpoint/region/bucket/keys.' },
      { type: 'discord', label: 'Discord', layer: 'direct', enableHint: 'Create a Discord webhook or bot profile.' },
      { type: 'huggingface', label: 'HuggingFace', layer: 'direct', enableHint: 'Create a HuggingFace profile with token + dataset repo.' },
      { type: 'github', label: 'GitHub', layer: 'direct', enableHint: 'Create a GitHub profile in Releases or Contents mode.' },
      {
        type: 'webdav',
        label: 'WebDAV (Mounted)',
        layer: 'mounted',
        enableHint: 'Recommended for mounted/aggregated storage (e.g. alist/openlist WebDAV endpoint).',
      },
    ];

    return c.json(status);
  });

  // --- Upload ---
  app.post('/upload', async (c) => {
    const { authService, guestService, uploadService } = getServices(c);
    const auth = authService.checkAuthentication(c.req.raw);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return jsonError(c, 400, 'NO_FILE', '未选择上传文件。', 'Multipart body 缺少 "file" 字段。');
    }

    const fileBuffer = await file.arrayBuffer();
    const fileSize = fileBuffer.byteLength;

    if (fileSize > container.config.uploadMaxSize) {
      return jsonError(
        c,
        413,
        'FILE_TOO_LARGE',
        '文件超过上传大小限制。',
        `上传上限为 ${Math.floor(container.config.uploadMaxSize / 1024 / 1024)}MB。`
      );
    }

    if (!auth.authenticated) {
      const guestCheck = guestService.checkUploadAllowed(c.req.raw, fileSize);
      if (!guestCheck.allowed) {
        return jsonError(c, guestCheck.status || 403, 'GUEST_REJECTED', '访客上传未通过限制检查。', guestCheck.reason);
      }
    }

    const storageMode = asString(body.storageMode || body.storage);
    const storageModeForLimit = storageMode || container.config.bootstrapDefaultStorage?.type || 'telegram';
    const uploadLimit = getUploadLimits()[storageModeForLimit];
    if (uploadLimit && fileSize > uploadLimit.maxBytes) {
      return jsonError(
        c,
        413,
        'STORAGE_FILE_TOO_LARGE',
        '文件超过当前存储上限。',
        uploadLimit.message || `当前存储上限为 ${Math.floor(uploadLimit.maxBytes / 1024 / 1024)}MB。`
      );
    }

    let result;
    try {
      result = await uploadService.uploadFile({
        fileName: file.name,
        mimeType: file.type,
        fileSize,
        buffer: fileBuffer,
        storageMode,
        storageId: asString(body.storageId || body.storage_config_id),
        folderPath: normalizeFolderPath(body.folderPath || body.folder || ''),
      });
    } catch (error) {
      const normalized = normalizeUploadError(c, error, 502);
      return c.json({ ...normalized, traceId: getTraceId(c) }, 502);
    }

    if (!auth.authenticated) {
      guestService.incrementUsage(c.req.raw);
    }

    return uploadSuccessResponse(c, result);
  });

  app.post('/api/upload-from-url', async (c) => {
    const { authService, guestService, uploadService } = getServices(c);
    const auth = authService.checkAuthentication(c.req.raw);
    const payload = await c.req.json().catch(() => ({}));

    if (!payload.url) {
      return jsonError(c, 400, 'URL_REQUIRED', '请输入 URL。', '请求体缺少 "url" 字段。');
    }

    if (!auth.authenticated) {
      const guestCheck = guestService.checkUploadAllowed(c.req.raw, 0);
      if (!guestCheck.allowed) {
        return jsonError(c, guestCheck.status || 403, 'GUEST_REJECTED', '访客上传未通过限制检查。', guestCheck.reason);
      }
    }

    let result;
    try {
      result = await uploadService.uploadFromUrl({
        url: payload.url,
        storageMode: asString(payload.storageMode || payload.storage),
        storageId: asString(payload.storageId || payload.storage_config_id),
        folderPath: normalizeFolderPath(payload.folderPath || payload.folder || ''),
        maxBytes: Math.min(container.config.uploadSmallFileThreshold, container.config.uploadMaxSize),
      });
    } catch (error) {
      const normalized = normalizeUploadError(c, error, 502);
      return c.json({ ...normalized, traceId: getTraceId(c) }, 502);
    }

    if (!auth.authenticated) {
      guestService.incrementUsage(c.req.raw);
    }

    return uploadSuccessResponse(c, result);
  });

  // --- Chunk upload ---
  app.post('/api/chunked-upload/init', async (c) => {
    const { authService, chunkService } = getServices(c);
    const auth = authService.checkAuthentication(c.req.raw);
    if (!auth.authenticated && authService.isAuthRequired()) {
      return jsonError(c, 403, 'GUEST_CHUNK_DISABLED', 'Guest users cannot use chunk upload.', 'Login required for chunk uploads.');
    }

    const body = await c.req.json().catch(() => ({}));
    const fileSize = Number(body.fileSize || 0);
    const totalChunks = Number(body.totalChunks || 0);

    if (!body.fileName || !fileSize || !totalChunks) {
      return jsonError(c, 400, 'MISSING_PARAMS', 'Missing required parameters.', 'fileName, fileSize and totalChunks are required.');
    }

    if (fileSize > container.config.uploadMaxSize) {
      return jsonError(
        c,
        413,
        'FILE_TOO_LARGE',
        'File exceeds upload size limit.',
        `Upload limit is ${Math.floor(container.config.uploadMaxSize / 1024 / 1024)}MB.`
      );
    }

    const storageMode = asString(body.storageMode);
    const storageModeForLimit = storageMode || container.config.bootstrapDefaultStorage?.type || 'telegram';
    const uploadLimit = getUploadLimits()[storageModeForLimit];
    if (uploadLimit) {
      if (fileSize > uploadLimit.maxBytes) {
        return jsonError(
          c,
          413,
          'STORAGE_FILE_TOO_LARGE',
          'File exceeds selected storage limit.',
          uploadLimit.message || `Selected storage limit is ${Math.floor(uploadLimit.maxBytes / 1024 / 1024)}MB.`
        );
      }
      if (fileSize > uploadLimit.directThreshold && uploadLimit.supportsChunkUpload === false) {
        return jsonError(
          c,
          400,
          'STORAGE_CHUNK_UNSUPPORTED',
          'Selected storage does not support chunk upload.',
          uploadLimit.message || 'Choose another storage backend for this file size.'
        );
      }
    }

    const init = chunkService.initTask({
      fileName: body.fileName,
      fileSize,
      fileType: body.fileType,
      totalChunks,
      storageMode,
      storageId: asString(body.storageId),
      folderPath: normalizeFolderPath(body.folderPath || body.folder || ''),
    });

    return c.json({ success: true, ...init });
  });

  app.get('/api/chunked-upload/init', (c) => {
    const { chunkService } = getServices(c);
    const uploadId = c.req.query('uploadId');
    if (!uploadId) return jsonError(c, 400, 'UPLOAD_ID_REQUIRED', 'uploadId is required.', 'Query parameter uploadId is missing.');

    const task = chunkService.getTask(uploadId);
    if (!task) return jsonError(c, 404, 'UPLOAD_TASK_NOT_FOUND', 'Upload task not found.', 'uploadId not found or expired.');

    return c.json({ success: true, task });
  });

  app.post('/api/chunked-upload/chunk', async (c) => {
    const { authService, chunkService } = getServices(c);
    const unauthorized = authService.isAuthRequired() ? requireAuth(c) : null;
    if (unauthorized) return unauthorized;

    const body = await c.req.parseBody();
    const uploadId = asString(body.uploadId);
    const chunkIndex = Number(body.chunkIndex);
    const chunk = body.chunk;

    if (!uploadId || Number.isNaN(chunkIndex) || !(chunk instanceof File)) {
      return jsonError(c, 400, 'MISSING_PARAMS', 'Missing required parameters.', 'uploadId, chunkIndex and chunk are required.');
    }

    const buffer = await chunk.arrayBuffer();
    chunkService.saveChunk({ uploadId, chunkIndex, buffer });

    return c.json({ success: true, chunkIndex });
  });

  app.post('/api/chunked-upload/complete', async (c) => {
    const { authService, chunkService } = getServices(c);
    const unauthorized = authService.isAuthRequired() ? requireAuth(c) : null;
    if (unauthorized) return unauthorized;

    const body = await c.req.json().catch(() => ({}));
    if (!body.uploadId) return jsonError(c, 400, 'UPLOAD_ID_REQUIRED', 'uploadId is required.', 'Request body uploadId is missing.');

    let result;
    try {
      result = await chunkService.complete(body.uploadId);
    } catch (error) {
      const normalized = normalizeUploadError(c, error, 502);
      return c.json({ ...normalized, traceId: getTraceId(c) }, 502);
    }

    return c.json({
      success: true,
      src: result.src,
      fileName: result.file.file_name,
      fileSize: result.file.file_size,
      fileId: result.file.id,
      folderPath: result.file.metadata?.folderPath || '',
    });
  });

  // --- File retrieval ---
  app.get('/api/file-info/:id', (c) => {
    const { fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const file = fileRepo.getById(id);

    if (!file) {
      return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`, false, { fileId: id });
    }

    return c.json({
      success: true,
      fileId: file.id,
      key: file.id,
      fileName: file.file_name,
      originalName: file.file_name,
      fileSize: file.file_size,
      uploadTime: file.created_at,
      storageType: file.storage_type,
      listType: file.list_type,
      label: file.label,
      liked: Boolean(file.liked),
      folderPath: file.metadata?.folderPath || '',
    });
  });

  app.get('/file/:id', async (c) => {
    const { uploadService, storageRepo, fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const range = c.req.header('range');

    // Handle signed Telegram file IDs (tgs_ prefix)
    if (id.startsWith('tgs_')) {
      try {
        return await handleSignedTelegramFile(id, range, storageRepo, c);
      } catch (error) {
        console.error('signed telegram file proxy error:', error);
        return c.text(`Signed file proxy error: ${error?.message || 'Unknown error'}`, 502);
      }
    }

    const file = fileRepo.getById(id);
    let shareAccess = { response: null, trackDownload: false };
    if (file) {
      shareAccess = verifyShareAccess(c, file);
      if (shareAccess.response) return shareAccess.response;
    }

    try {
      const result = await uploadService.getFileResponse(id, range);
      if (!result) {
        return c.text('File not found', 404);
      }

      const upstream = result.response;
      const headers = buildFileProxyHeaders(result, upstream.headers);

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });

      if (file && shareAccess?.trackDownload && shouldCountAsDownload(c, response)) {
        incrementShareDownloadCount(fileRepo, file);
      }

      return response;
    } catch (error) {
      console.error('file proxy route error:', error);
      return c.text(`File proxy error: ${error?.message || 'Unknown error'}`, 502);
    }
  });

  app.options('/file/:id', (c) => c.body(null, 204));
  app.on('HEAD', '/file/:id', async (c) => {
    const { uploadService, storageRepo, fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const range = c.req.header('range');

    if (id.startsWith('tgs_')) {
      try {
        return await handleSignedTelegramFile(id, range, storageRepo, c, true);
      } catch (error) {
        console.error('signed telegram file HEAD error:', error);
        return c.body(null, 502);
      }
    }

    const file = fileRepo.getById(id);
    if (file) {
      const shareAccess = verifyShareAccess(c, file);
      if (shareAccess.response) return shareAccess.response;
    }

    try {
      const result = await uploadService.getFileResponse(id, range);
      if (!result) {
        return c.body(null, 404);
      }

      const upstream = result.response;
      const headers = buildFileProxyHeaders(result, upstream.headers);

      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      console.error('file proxy HEAD route error:', error);
      return c.body(null, 502, {
        'X-File-Proxy-Error': String(error?.message || 'Unknown error').slice(0, 200),
      });
    }
  });

  app.get('/s/:slug', (c) => {
    const { fileRepo } = getServices(c);
    const rawValue = decodePathParam(c.req.param('slug'));
    if (!rawValue) {
      return c.text('Not found', 404);
    }

    let targetId = '';
    const slug = sanitizeSlug(rawValue);
    if (slug) {
      const mapped = fileRepo.findByShareSlug(slug);
      if (mapped) {
        targetId = mapped.id;
      }
    }

    if (!targetId) {
      targetId = rawValue;
    }

    const redirectUrl = new URL(`/file/${encodeURIComponent(targetId)}`, c.req.url);
    const sourceUrl = new URL(c.req.url);
    sourceUrl.searchParams.forEach((value, key) => {
      redirectUrl.searchParams.set(key, value);
    });

    return c.redirect(redirectUrl.toString(), 302);
  });

  app.get('/share/:id', async (c) => {
    const { uploadService } = getServices(c);
    const fileId = decodeURIComponent(c.req.param('id'));
    const expiresAt = Number(c.req.query('exp') || 0);
    const signature = c.req.query('sig') || '';
    const range = c.req.header('range');

    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return c.text('Invalid share expiry.', 400);
    }
    if (Date.now() > expiresAt) {
      return c.text('Share link expired.', 410);
    }

    const secret = container.config.sessionSecret || container.config.configEncryptionKey;
    if (!verifyShareSignature({ fileId, expiresAt, signature, secret })) {
      return c.text('Invalid share signature.', 403);
    }

    try {
      const result = await uploadService.getFileResponse(fileId, range);
      if (!result) {
        return c.text('File not found', 404);
      }

      const upstream = result.response;
      const headers = buildFileProxyHeaders(result, upstream.headers);
      headers.set('Cache-Control', 'private, max-age=60');

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      console.error('share proxy route error:', error);
      return c.text(`Share proxy error: ${error?.message || 'Unknown error'}`, 502);
    }
  });

  app.options('/share/:id', (c) => c.body(null, 204));

  app.post('/api/share/sign', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const fileId = asString(body.fileId || body.id).trim();
    if (!fileId) {
      return jsonError(c, 400, 'FILE_ID_REQUIRED', 'fileId is required.', 'Provide fileId in request body.');
    }

    const file = fileRepo.getById(fileId);
    if (!file) {
      return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${fileId}" does not exist.`);
    }

    const expiresAt = parseShareExpiry(body.ttlSeconds || body.expiresIn || body.ttl || undefined);
    const secret = container.config.sessionSecret || container.config.configEncryptionKey;
    const signature = createShareSignature({ fileId, expiresAt, secret });
    const sharePath = `/share/${encodeURIComponent(fileId)}?exp=${expiresAt}&sig=${encodeURIComponent(signature)}`;

    return c.json({
      success: true,
      permission: 'public-read-signed',
      expiresAt,
      sharePath,
      shareUrl: toAbsoluteUrl(c, sharePath),
      directPath: `/file/${encodeURIComponent(fileId)}`,
      directUrl: toAbsoluteUrl(c, `/file/${encodeURIComponent(fileId)}`),
    });
  });

  // --- Manage API ---
  app.get('/api/manage/list', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const limit = parseBoundedInt(
      firstNonEmpty(c.req.query('limit'), c.req.query('pageSize'), c.req.query('size')),
      100,
      1,
      1000
    );

    let cursor = firstNonEmpty(c.req.query('cursor'), c.req.query('offset'));
    if (!cursor) {
      const current = parseBoundedInt(
        firstNonEmpty(c.req.query('page'), c.req.query('current')),
        1,
        1,
        Number.MAX_SAFE_INTEGER
      );
      cursor = current > 1 ? String((current - 1) * limit) : null;
    }

    const storage = c.req.query('storage') || 'all';
    const search = c.req.query('search') || '';
    const listType = c.req.query('listType') || c.req.query('list_type') || 'all';
    const folderPath = normalizeFolderPath(c.req.query('folderPath') || c.req.query('path') || '');

    const includeStatsRaw = String(c.req.query('includeStats') || c.req.query('stats') || '').toLowerCase();
    const includeStats = ['1', 'true', 'yes'].includes(includeStatsRaw);

    const payload = fileRepo.list({
      limit,
      cursor,
      includeStats,
      filters: {
        storageType: storage,
        search,
        listType,
        folderPath: c.req.query('folderPath') != null || c.req.query('path') != null ? folderPath : undefined,
      },
    });

    return c.json(payload);
  });

  app.get('/api/drive/tree', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const storage = c.req.query('storage') || 'all';

    const nodes = fileRepo.listFolderTree({
      storageType: storage,
    });

    return c.json({
      success: true,
      nodes,
    });
  });

  app.get('/api/drive/explorer', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const limit = parseBoundedInt(c.req.query('limit'), 100, 1, 1000);
    const cursor = c.req.query('cursor');
    const storage = c.req.query('storage') || 'all';
    const search = c.req.query('search') || '';
    const listType = c.req.query('listType') || c.req.query('list_type') || 'all';
    const includeStatsRaw = String(c.req.query('includeStats') || c.req.query('stats') || '').toLowerCase();
    const includeStats = ['1', 'true', 'yes'].includes(includeStatsRaw);
    const folderPath = normalizeFolderPath(c.req.query('path') || c.req.query('folderPath') || '');

    const payload = fileRepo.listExplorer({
      folderPath,
      limit,
      cursor,
      includeStats,
      filters: {
        storageType: storage,
        search,
        listType,
      },
    });

    return c.json({
      success: true,
      ...payload,
    });
  });

  app.get('/api/manage/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const storage = c.req.query('storage') || 'all';

    const folders = fileRepo.listFolderTree({
      storageType: storage,
    });

    return c.json({
      success: true,
      folders,
    });
  });

  app.post('/api/drive/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const path = normalizeFolderPath(body.path || body.folderPath);

    if (!path) {
      return jsonError(c, 400, 'PATH_REQUIRED', 'path is required.', 'Provide path or folderPath.');
    }

    const folder = fileRepo.createFolder(path);
    return c.json({ success: true, folder });
  });
  app.post('/api/manage/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const path = normalizeFolderPath(body.path || body.folderPath);
    if (!path) {
      return jsonError(c, 400, 'PATH_REQUIRED', 'path is required.', 'Provide path or folderPath.');
    }
    const folder = fileRepo.createFolder(path);
    return c.json({ success: true, folder });
  });

  app.post('/api/drive/folders/move', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const sourcePath = normalizeFolderPath(body.sourcePath);
    let targetPath = normalizeFolderPath(body.targetPath);
    if (!targetPath && body.targetParentPath && body.newName) {
      targetPath = normalizeFolderPath(`${body.targetParentPath}/${body.newName}`);
    }

    if (!sourcePath || !targetPath) {
      return jsonError(
        c,
        400,
        'MOVE_PATHS_REQUIRED',
        'sourcePath and targetPath are required.',
        'Provide both sourcePath and targetPath.'
      );
    }

    const result = fileRepo.moveFolder(sourcePath, targetPath);
    return c.json({ success: true, ...result });
  });
  app.put('/api/manage/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const sourcePath = normalizeFolderPath(body.sourcePath || body.path || '');
    const targetPath = normalizeFolderPath(body.targetPath || body.newPath || '');
    if (!sourcePath || !targetPath) {
      return jsonError(
        c,
        400,
        'MOVE_PATHS_REQUIRED',
        'sourcePath and targetPath are required.',
        'Provide both sourcePath and targetPath.'
      );
    }
    const result = fileRepo.moveFolder(sourcePath, targetPath);
    return c.json({ success: true, ...result });
  });

  app.delete('/api/drive/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo, uploadService } = getServices(c);
    const path = normalizeFolderPath(c.req.query('path'));
    const recursive = isTruthy(c.req.query('recursive'));

    if (!path) {
      return jsonError(c, 400, 'PATH_REQUIRED', 'path is required.', 'Provide path query parameter.');
    }

    if (recursive) {
      const fileIds = fileRepo.listFileIdsByFolderPrefix(path);
      for (const fileId of fileIds) {
        await uploadService.deleteFile(fileId);
      }
    }

    const result = fileRepo.deleteFolder(path, { recursive });
    return c.json({
      success: true,
      recursive,
      ...result,
    });
  });
  app.delete('/api/manage/folders', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const path = normalizeFolderPath(c.req.query('path'));
    const recursive = isTruthy(c.req.query('recursive'));
    if (!path) {
      return jsonError(c, 400, 'PATH_REQUIRED', 'path is required.', 'Provide path query parameter.');
    }

    let movedFiles = 0;
    if (recursive) {
      const fileIds = fileRepo.listFileIdsByFolderPrefix(path);
      const moved = fileRepo.moveFiles(fileIds, '');
      movedFiles = Number(moved.moved || 0);
    }

    const result = fileRepo.deleteFolder(path, { recursive });
    return c.json({
      success: true,
      recursive,
      movedFiles,
      ...result,
    });
  });

  app.post('/api/drive/files/move', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const ids = collectMoveIdentifiers(body);
    const targetFolderPath = normalizeFolderPath(body.targetFolderPath || body.path || '');

    const result = fileRepo.moveFiles(ids, targetFolderPath);
    if (result.moved === 0) {
      return jsonError(
        c,
        404,
        'FILES_NOT_MOVED',
        '没有找到可移动的文件，目录未变更。',
        '请刷新文件列表后重试。'
      );
    }
    return c.json({
      success: true,
      ...result,
    });
  });
  app.post('/api/manage/files/move-folder', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const ids = collectMoveIdentifiers(body);
    const targetFolderPath = normalizeFolderPath(body.targetFolderPath || body.folderPath || body.path || '');

    const result = fileRepo.moveFiles(ids, targetFolderPath);
    if (result.moved === 0) {
      return jsonError(
        c,
        404,
        'FILES_NOT_MOVED',
        '没有找到可移动的文件，目录未变更。',
        '请刷新文件列表后重试。'
      );
    }
    return c.json({
      success: true,
      ...result,
    });
  });

  app.post('/api/drive/files/rename', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const id = asString(body.id).trim();
    const fileName = asString(body.fileName || body.name).trim();

    if (!id || !fileName) {
      return jsonError(
        c,
        400,
        'FILE_RENAME_PARAMS_REQUIRED',
        'id and fileName are required.',
        'Provide id and fileName in request body.'
      );
    }

    const updated = fileRepo.updateMetadata(id, { fileName });
    if (!updated) {
      return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);
    }

    return c.json({
      success: true,
      file: {
        id: updated.id,
        fileName: updated.file_name,
      },
    });
  });

  app.post('/api/drive/files/delete-batch', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { uploadService } = getServices(c);
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return jsonError(c, 400, 'IDS_REQUIRED', 'ids is required.', 'Provide at least one file id.');
    }

    let deleted = 0;
    for (const id of ids) {
      const result = await uploadService.deleteFile(id);
      if (result.deleted) deleted += 1;
    }

    return c.json({
      success: true,
      requested: ids.length,
      deleted,
    });
  });

  app.get('/api/manage/toggleLike/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const file = fileRepo.getById(id);
    if (!file) return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);

    const updated = fileRepo.updateMetadata(id, { liked: !Boolean(file.liked) });
    return c.json({ success: true, liked: Boolean(updated.liked) });
  });

  app.get('/api/manage/editName/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const newName = String(c.req.query('newName') || '').trim();

    if (!newName) return jsonError(c, 400, 'NEW_NAME_REQUIRED', 'newName is required.', 'Provide newName query parameter.');
    const updated = fileRepo.updateMetadata(id, { fileName: newName });
    if (!updated) return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);

    return c.json({ success: true, fileName: updated.file_name, key: updated.id });
  });

  app.get('/api/manage/block/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const action = c.req.query('action');
    const nextListType = isTruthy(action) ? 'Block' : 'White';
    const updated = fileRepo.updateMetadata(id, { listType: nextListType });
    if (!updated) return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);

    return c.json({ success: true, listType: nextListType, key: updated.id });
  });

  app.get('/api/manage/white/:id', (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { fileRepo } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const action = c.req.query('action');
    const nextListType = isTruthy(action) ? 'White' : 'None';
    const updated = fileRepo.updateMetadata(id, { listType: nextListType });
    if (!updated) return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);

    return c.json({ success: true, listType: nextListType, key: updated.id });
  });

  app.get('/api/manage/delete/:id', async (c) => {
    const unauthorized = requireAuth(c);
    if (unauthorized) return unauthorized;

    const { uploadService } = getServices(c);
    const id = decodeURIComponent(c.req.param('id'));
    const result = await uploadService.deleteFile(id);

    if (!result.deleted) {
      return jsonError(c, 404, 'FILE_NOT_FOUND', 'File not found.', `File "${id}" does not exist.`);
    }

    return c.json({ success: true, message: 'File deleted.', fileId: id });
  });

  // --- Misc ---
  app.get('/api/bing/wallpaper', async (c) => {
    const response = await fetch('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
    if (!response.ok) {
      return jsonError(
        c,
        502,
        'UPSTREAM_BING_FAILED',
        'Failed to fetch Bing wallpapers.',
        `Bing upstream returned HTTP ${response.status}.`,
        true
      );
    }
    const json = await response.json();
    return c.json({ status: true, message: 'ok', data: json.images || [] });
  });
  app.get('/api/bing/wallpaper/', async (c) => {
    const response = await fetch('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
    if (!response.ok) {
      return jsonError(
        c,
        502,
        'UPSTREAM_BING_FAILED',
        'Failed to fetch Bing wallpapers.',
        `Bing upstream returned HTTP ${response.status}.`,
        true
      );
    }
    const json = await response.json();
    return c.json({ status: true, message: 'ok', data: json.images || [] });
  });

  app.post('/api/telegram/webhook', async (c) => {
    const { storageRepo } = getServices(c);

    // Resolve Telegram storage config (from DB or env bootstrap)
    const telegramConfig = (() => {
      const dbConfig = storageRepo.findEnabledByType('telegram')[0];
      if (dbConfig?.config?.botToken && dbConfig?.config?.chatId) {
        return {
          botToken: dbConfig.config.botToken,
          chatId: dbConfig.config.chatId,
          apiBase: dbConfig.config.apiBase || container.config.telegramApiBase,
        };
      }
      const bootstrap = container.config.bootstrapDefaultStorage?.telegram;
      if (bootstrap?.botToken && bootstrap?.chatId) {
        return { botToken: bootstrap.botToken, chatId: bootstrap.chatId, apiBase: bootstrap.apiBase };
      }
      return null;
    })();

    if (!telegramConfig?.botToken) {
      return c.json({ ok: false, error: 'No Telegram bot token configured.' }, 500);
    }

    // Build env-like object for utility functions
    const env = {
      ...process.env,
      TG_Bot_Token: telegramConfig.botToken,
      TG_Chat_ID: telegramConfig.chatId,
      CUSTOM_BOT_API_URL: telegramConfig.apiBase,
      PUBLIC_BASE_URL: container.config.publicBaseUrl,
      FILE_URL_SECRET: container.config.configEncryptionKey,
    };

    // Verify webhook secret if configured
    const expectedSecret = env.TG_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
      if (headerSecret !== expectedSecret) {
        return c.json({ ok: false, error: 'Invalid webhook secret.' }, 401);
      }
    }

    let update;
    try {
      update = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body.' }, 400);
    }

    const message = update?.message || update?.channel_post;
    if (!message) {
      return c.json({ ok: true, ignored: 'no-message' });
    }

    const media = getTelegramFileFromMessage(message);
    if (!media) {
      return c.json({ ok: true, ignored: 'message-without-file' });
    }

    const useSigned = shouldUseSignedTelegramLinks(env);
    const directId = useSigned
      ? createSignedTelegramFileId(
          {
            fileId: media.fileId,
            fileExtension: media.fileExtension,
            fileName: media.fileName,
            mimeType: media.mimeType,
            fileSize: media.fileSize,
            messageId: media.messageId,
          },
          env
        )
      : `${media.fileId}.${media.fileExtension}`;

    // Store file metadata in SQLite if enabled
    if (shouldWriteTelegramMetadata(env)) {
      try {
        const { fileRepo } = getServices(c);
        const publicId = `${media.fileId}.${media.fileExtension}`;
        const existing = fileRepo.getById(publicId);
        if (!existing) {
          fileRepo.create({
            id: publicId,
            storageConfigId: 'telegram-webhook',
            storageType: 'telegram',
            storageKey: media.fileId,
            fileName: media.fileName,
            fileSize: media.fileSize,
            mimeType: media.mimeType,
            folderPath: '',
            extra: {
              fromWebhook: true,
              signedLink: useSigned,
              telegramFileId: media.fileId,
              telegramMessageId: media.messageId || undefined,
            },
          });
        }
      } catch (dbErr) {
        console.error('[telegram-webhook] metadata store error:', dbErr.message);
      }
    }

    const requestUrl = new URL(c.req.url);
    const origin = `${requestUrl.protocol}//${requestUrl.host}`;
    const directLink = buildTelegramDirectLink(env, directId, origin);
    const chatId = message?.chat?.id;
    let reply = normalizeTelegramReplyResult(null, chatId);

    if (chatId) {
      const noticeResult = await sendTelegramUploadNotice(
        {
          chatId,
          replyToMessageId: message.message_id,
          directLink,
          fileId: media.fileId,
          messageId: media.messageId || message.message_id,
          fileName: media.fileName,
          fileSize: media.fileSize,
        },
        env
      );
      reply = normalizeTelegramReplyResult(noticeResult, chatId);
      if (!noticeResult?.ok && !noticeResult?.skipped) {
        console.warn(
          '[telegram-webhook] reply failed:',
          noticeResult?.data?.description || noticeResult?.error || 'unknown error'
        );
      }
    }

    return c.json({
      ok: true,
      directLink,
      storageType: 'telegram',
      mode: useSigned ? 'signed' : 'direct',
      update: {
        chatId,
        messageId: message.message_id,
        mediaKind: media.kind,
      },
      reply,
    });
  });

  app.get('/api/health', (c) => {
    return c.json({ ok: true, mode: 'docker-node', timestamp: Date.now() });
  });

  return app;
}

module.exports = {
  createApp,
};
