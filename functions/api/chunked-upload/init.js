/**
 * Initialize chunked upload task.
 * POST /api/chunked-upload/init
 */
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { checkGuestUpload } from '../../utils/guest.js';

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.img_url) {
      return jsonResponse({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
    }

    const isAdmin = isAuthRequired(env)
      ? (await checkAuthentication(context)).authenticated
      : true;

    if (!isAdmin) {
      const guestCheck = await checkGuestUpload(request, env, 0);
      if (!guestCheck.allowed) {
        return jsonResponse({ error: '访客不支持分片上传，请使用普通上传' }, 403);
      }
    }

    const body = await request.json();
    const { fileName, fileSize, fileType, totalChunks, storageMode } = body || {};
    const folderPath = normalizeFolderPath(body?.folderPath || body?.folder || '');
    const normalizedFileSize = Number(fileSize || 0);
    const normalizedTotalChunks = Number(totalChunks || 0);

    if (!fileName || !normalizedFileSize || !normalizedTotalChunks) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    const validModes = ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'];
    const normalizedStorage = validModes.includes(storageMode) ? storageMode : 'telegram';

    const validation = validateChunkUpload(normalizedStorage, normalizedFileSize);
    if (!validation.ok) {
      return jsonResponse({ error: validation.message, code: validation.code }, validation.status);
    }

    const uploadId = generateUploadId();

    const chunkBackend = resolveChunkBackend(env);

    const uploadTask = {
      uploadId,
      fileName,
      fileSize: normalizedFileSize,
      fileType,
      totalChunks: normalizedTotalChunks,
      storageMode: normalizedStorage,
      folderPath,
      chunkBackend,
      uploadedChunks: [],
      createdAt: Date.now(),
      status: 'pending',
    };

    await env.img_url.put(`upload:${uploadId}`, JSON.stringify(uploadTask), {
      expirationTtl: 3600,
    });

    return jsonResponse({
      success: true,
      uploadId,
      chunkSize: CHUNK_SIZE,
      chunkBackend,
    });
  } catch (error) {
    console.error('Init upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /api/chunked-upload/init?uploadId=xxx
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');

  if (!uploadId) {
    return jsonResponse({ error: '缺少 uploadId' }, 400);
  }

  if (!env.img_url) {
    return jsonResponse({ error: 'KV binding img_url is required.' }, 500);
  }

  try {
    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }

    return jsonResponse({
      success: true,
      ...taskData,
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resolveChunkBackend(env) {
  const mode = String(env.CHUNK_BACKEND || 'auto').toLowerCase();
  if (mode === 'kv') return 'kv';
  if (mode === 'r2') return env.R2_BUCKET ? 'r2' : 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function generateUploadId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function validateChunkUpload(storageMode, fileSize) {
  if (fileSize > MAX_FILE_SIZE) {
    return {
      ok: false,
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `文件大小超过限制 (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
    };
  }

  if (storageMode === 'telegram' && fileSize > TELEGRAM_WEB_UPLOAD_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      message: 'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。更大的文件请切换到 R2/S3/WebDAV/GitHub，或把文件直接发到 Telegram 后使用 Webhook 回链。',
    };
  }

  if (storageMode === 'discord' && fileSize > 25 * 1024 * 1024) {
    return {
      ok: false,
      status: 413,
      code: 'DISCORD_FILE_TOO_LARGE',
      message: 'Discord 默认上传上限按 25MB 处理；更大的文件请使用 R2/S3/WebDAV/GitHub。',
    };
  }

  if (storageMode === 'huggingface' && fileSize > 35 * 1024 * 1024) {
    return {
      ok: false,
      status: 413,
      code: 'HUGGINGFACE_FILE_TOO_LARGE',
      message: 'HuggingFace 普通上传链路建议控制在 35MB 以内；更大的文件请使用 LFS 或其他对象存储。',
    };
  }

  return { ok: true };
}

function normalizeFolderPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}
