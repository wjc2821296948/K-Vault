const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Base64url helpers (Node.js buffer-based)
// ---------------------------------------------------------------------------

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf-8');
  return buf.toString('base64url');
}

function base64UrlDecodeToBuffer(input) {
  return Buffer.from(String(input || ''), 'base64url');
}

function base64UrlDecodeToString(input) {
  return base64UrlDecodeToBuffer(input).toString('utf-8');
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing (node:crypto, synchronous)
// ---------------------------------------------------------------------------

function signPayload(payload, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(String(payload))
    .digest('base64url');
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Config helpers – read from process.env style object
// ---------------------------------------------------------------------------

function shouldUseSignedTelegramLinks(env) {
  const mode = String(env?.TELEGRAM_LINK_MODE || '').toLowerCase();
  if (mode === 'signed') return true;
  return env?.MINIMIZE_KV_WRITES === 'true';
}

function shouldWriteTelegramMetadata(env) {
  const metadataMode = String(env?.TELEGRAM_METADATA_MODE || '').trim().toLowerCase();
  if (['off', 'none', 'disable', 'disabled', 'minimal'].includes(metadataMode)) return false;
  if (['on', 'full', 'always', 'enable', 'enabled'].includes(metadataMode)) return true;

  const skip = String(env?.TELEGRAM_SKIP_METADATA || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(skip)) return false;

  return true;
}

function shouldNotifyTelegramUpload(env) {
  const raw = env?.TG_UPLOAD_NOTIFY ?? env?.TELEGRAM_UPLOAD_NOTIFY;
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized) return true;
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Direct link helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw) {
  if (!raw) return '';
  try {
    return new URL(String(raw)).toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function buildTelegramDirectLink(env, directId, fallbackOrigin) {
  const base = normalizeBaseUrl(env?.PUBLIC_BASE_URL) || normalizeBaseUrl(fallbackOrigin);
  if (!base) return `/file/${directId}`;
  return `${base}/file/${directId}`;
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers
// ---------------------------------------------------------------------------

function getTelegramApiBase(env) {
  const raw = env?.CUSTOM_BOT_API_URL;
  if (!raw || typeof raw !== 'string') return 'https://api.telegram.org';
  const trimmed = raw.trim();
  if (!trimmed) return 'https://api.telegram.org';
  try {
    return new URL(trimmed).toString().replace(/\/+$/, '');
  } catch {
    return 'https://api.telegram.org';
  }
}

function buildTelegramBotApiUrl(env, method) {
  const base = getTelegramApiBase(env);
  const token = env?.TG_Bot_Token || '';
  return `${base}/bot${token}/${String(method || '').replace(/^\/+/, '')}`;
}

function buildTelegramFileUrl(env, filePath) {
  const base = getTelegramApiBase(env);
  const token = env?.TG_Bot_Token || '';
  return `${base}/file/bot${token}/${String(filePath || '').replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------
// Message file extraction (ported from functions/utils/telegram.js)
// ---------------------------------------------------------------------------

const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac',
  'audio/mp4': 'm4a', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'application/x-7z-compressed': '7z', 'application/x-rar-compressed': 'rar',
  'text/plain': 'txt', 'application/json': 'json',
};

function sanitizeFileExtension(ext, fallback = 'bin') {
  const normalized = String(ext || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized ? normalized.slice(0, 10) : fallback;
}

function guessExtensionFromMimeType(mimeType, fallback = 'bin') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP[normalized] || fallback;
}

function getFileExtension(fileName, mimeType, fallback = 'bin') {
  const fromName = String(fileName || '').split('.').pop()?.toLowerCase();
  if (fromName && fromName !== String(fileName || '').toLowerCase()) {
    return sanitizeFileExtension(fromName, fallback);
  }
  if (String(fileName || '').includes('.')) {
    return sanitizeFileExtension(fromName, fallback);
  }
  return sanitizeFileExtension(guessExtensionFromMimeType(mimeType, fallback), fallback);
}

function getTelegramFileFromMessage(message) {
  if (!message) return null;

  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo.reduce((prev, current) =>
      (prev?.file_size || 0) > (current?.file_size || 0) ? prev : current
    );
    const ext = 'jpg';
    const fileName = `photo_${message.message_id || Date.now()}.${ext}`;
    return {
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || '',
      mimeType: 'image/jpeg',
      fileSize: Number(photo.file_size || 0),
      fileExtension: ext,
      fileName,
      messageId: Number(message.message_id || 0),
    };
  }

  const candidates = [
    { key: 'document', fallbackName: 'document', fallbackMime: 'application/octet-stream' },
    { key: 'video', fallbackName: 'video', fallbackMime: 'video/mp4' },
    { key: 'audio', fallbackName: 'audio', fallbackMime: 'audio/mpeg' },
    { key: 'voice', fallbackName: 'voice', fallbackMime: 'audio/ogg' },
    { key: 'animation', fallbackName: 'animation', fallbackMime: 'video/mp4' },
    { key: 'video_note', fallbackName: 'video_note', fallbackMime: 'video/mp4' },
    { key: 'sticker', fallbackName: 'sticker', fallbackMime: 'image/webp' },
  ];

  for (const item of candidates) {
    const data = message[item.key];
    if (!data?.file_id) continue;

    const mimeType = data.mime_type || item.fallbackMime;
    const ext = getFileExtension(data.file_name, mimeType, 'bin');
    const fileName = data.file_name || `${item.fallbackName}_${message.message_id || Date.now()}.${ext}`;
    return {
      kind: item.key,
      fileId: data.file_id,
      fileUniqueId: data.file_unique_id || '',
      mimeType,
      fileSize: Number(data.file_size || 0),
      fileExtension: ext,
      fileName,
      messageId: Number(message.message_id || 0),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signed file ID creation & parsing
// ---------------------------------------------------------------------------

function getFileLinkSecrets(env) {
  const candidates = [
    env?.FILE_URL_SECRET,
    env?.TG_FILE_URL_SECRET,
    env?.TG_Bot_Token,
    'k-vault-default-secret',
    'tgbed-default-secret',
  ];
  return [...new Set(candidates.map((v) => (v == null ? '' : String(v).trim())).filter(Boolean))];
}

function truncateFileName(fileName, limit = 180) {
  if (!fileName) return '';
  const str = String(fileName);
  return str.length <= limit ? str : str.slice(0, limit);
}

function createSignedTelegramFileId({ fileId, fileExtension, fileName, mimeType, fileSize, messageId }, env) {
  const ext = sanitizeFileExtension(fileExtension || 'bin');
  const payloadObj = {
    v: 1,
    f: String(fileId || ''),
    e: ext,
    n: truncateFileName(fileName || ''),
    m: String(mimeType || ''),
    s: Number(fileSize || 0),
    t: Date.now(),
    mid: messageId ? Number(messageId) : undefined,
  };
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const [primarySecret] = getFileLinkSecrets(env);
  const signature = signPayload(payload, primarySecret);
  return `tgs_${payload}.${signature}.${ext}`;
}

function parseSignedTelegramFileId(id, env) {
  const raw = String(id || '');
  const match = /^tgs_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+))?$/.exec(raw);
  if (!match) return null;

  const payload = match[1];
  const signature = match[2];
  const extFromSuffix = sanitizeFileExtension(match[3] || 'bin');
  const secrets = getFileLinkSecrets(env);

  let isValid = false;
  for (const secret of secrets) {
    const expected = signPayload(payload, secret);
    if (timingSafeCompare(signature, expected)) {
      isValid = true;
      break;
    }
  }
  if (!isValid) return null;

  let parsed;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(payload));
  } catch {
    return null;
  }
  if (!parsed?.f) return null;

  return {
    version: parsed.v || 1,
    fileId: String(parsed.f),
    fileExtension: sanitizeFileExtension(parsed.e || extFromSuffix || 'bin'),
    fileName: parsed.n ? String(parsed.n) : '',
    mimeType: parsed.m ? String(parsed.m) : '',
    fileSize: Number(parsed.s || 0),
    timestamp: Number(parsed.t || 0),
    messageId: parsed.mid ? Number(parsed.mid) : null,
  };
}

// ---------------------------------------------------------------------------
// Upload notification
// ---------------------------------------------------------------------------

function formatFileSize(bytes) {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(2)} KB`;
  if (numeric < 1024 * 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(2)} MB`;
  return `${(numeric / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildTelegramUploadNoticeText({ directLink, fileId, messageId, fileName, fileSize }) {
  const safeName = truncateFileName(fileName || '', 120) || 'unnamed';
  const lines = [
    'Upload completed',
    `Name: ${safeName}`,
    `Size: ${formatFileSize(fileSize)}`,
    `Direct Link: ${directLink}`,
    `File ID: ${fileId}`,
  ];
  if (messageId) lines.push(`Message ID: ${messageId}`);
  return lines.join('\n');
}

async function sendTelegramUploadNotice(
  { chatId, replyToMessageId, directLink, fileId, messageId, fileName, fileSize, text },
  env
) {
  if (!shouldNotifyTelegramUpload(env)) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const targetChatId = chatId || env?.TG_Chat_ID;
  if (!targetChatId || !env?.TG_Bot_Token) {
    return { ok: false, skipped: true, reason: 'missing-config' };
  }

  const finalText = text || buildTelegramUploadNoticeText({
    directLink, fileId, messageId, fileName, fileSize,
  });

  const payload = {
    chat_id: targetChatId,
    text: finalText,
    disable_web_page_preview: true,
  };

  if (replyToMessageId) {
    payload.reply_to_message_id = Number(replyToMessageId);
    payload.allow_sending_without_reply = true;
  }

  try {
    let result = await postTelegramMessage(payload, env);
    if (!result.ok && payload.reply_to_message_id) {
      const fallbackPayload = {
        chat_id: targetChatId,
        text: finalText,
        disable_web_page_preview: true,
      };
      result = await postTelegramMessage(fallbackPayload, env);
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function postTelegramMessage(payload, env) {
  const response = await fetch(buildTelegramBotApiUrl(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data?.ok, data };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getTelegramFileFromMessage,
  createSignedTelegramFileId,
  parseSignedTelegramFileId,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
  shouldNotifyTelegramUpload,
  buildTelegramDirectLink,
  sendTelegramUploadNotice,
  buildTelegramUploadNoticeText,
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  sanitizeFileExtension,
  getFileLinkSecrets,
};
