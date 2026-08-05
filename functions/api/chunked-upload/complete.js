/**
 * Complete chunked upload request.
 * POST /api/chunked-upload/complete
 */
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { createS3Client } from '../../utils/s3client.js';
import { uploadToDiscord } from '../../utils/discord.js';
import { hasHuggingFaceConfig, uploadToHuggingFace } from '../../utils/huggingface.js';
import { hasWebDAVConfig, normalizeWebDAVPath, uploadToWebDAV } from '../../utils/webdav.js';
import { hasGitHubConfig, normalizeGitHubStoragePath, uploadToGitHub } from '../../utils/github.js';
import {
  buildTelegramDirectLink,
  buildTelegramBotApiUrl,
  createSignedTelegramFileId,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from '../../utils/telegram.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';
const MB = 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (isAuthRequired(env)) {
      const auth = await checkAuthentication(context);
      if (!auth.authenticated) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }

    if (!env.img_url) {
      return jsonResponse({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
    }

    const body = await request.json();
    const { uploadId } = body || {};

    if (!uploadId) {
      return jsonResponse({ error: '缺少 uploadId' }, 400);
    }

    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }
    const totalChunks = Number(taskData.totalChunks || 0);
    if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
      return jsonResponse({ error: 'Invalid totalChunks in upload task.' }, 400);
    }

    const chunkBackend = resolveChunkBackend(taskData, env);
    const completionValidation = validateCompletionTarget(taskData.storageMode || 'telegram', Number(taskData.fileSize || 0));
    if (!completionValidation.ok) {
      return jsonResponse({ error: completionValidation.message, code: completionValidation.code }, completionValidation.status);
    }

    if (!isKvWriteMinimized(env)) {
      if (!Array.isArray(taskData.uploadedChunks) || taskData.uploadedChunks.length !== totalChunks) {
        return jsonResponse(
          {
            error: '分片未完全上传',
            uploaded: Array.isArray(taskData.uploadedChunks) ? taskData.uploadedChunks.length : 0,
            total: totalChunks,
            missingChunks: getMissingChunks(taskData.uploadedChunks || [], totalChunks),
          },
          400
        );
      }
    }

    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkData = await readChunkData(uploadId, i, chunkBackend, env);
      if (!chunkData) {
        return jsonResponse({ error: `分片 ${i} 数据缺失` }, 500);
      }
      chunks.push(chunkData);
    }

    const completeFile = new Blob(chunks, { type: taskData.fileType || 'application/octet-stream' });
    const file = new File([completeFile], taskData.fileName, { type: taskData.fileType || 'application/octet-stream' });

    const fileExtension = getFileExtension(taskData.fileName);
    let storageType = taskData.storageMode || 'telegram';
    const folderPath = normalizeFolderPath(taskData.folderPath || '');
    let responseFileKey = null;
    let metadataKey = null;
    let extraMetadata = {};
    let telegramNoticePayload = null;

    if (storageType === 'r2') {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: 'R2 未配置，无法完成上传' }, 500);
      }
      const uploadResult = await uploadToR2(file, fileExtension, env);
      responseFileKey = uploadResult.fileKey;
      metadataKey = uploadResult.fileKey;
    } else if (storageType === 's3') {
      if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID) {
        return jsonResponse({ error: 'S3 未配置，无法完成上传' }, 500);
      }
      const s3 = createS3Client(env);
      const s3Id = `s3_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const s3Key = `${s3Id}.${fileExtension}`;
      const arrayBuffer = await file.arrayBuffer();
      await s3.putObject(s3Key, arrayBuffer, {
        contentType: file.type || 'application/octet-stream',
        metadata: { 'x-amz-meta-filename': taskData.fileName },
      });
      responseFileKey = `s3:${s3Key}`;
      metadataKey = responseFileKey;
      extraMetadata.s3Key = s3Key;
    } else if (storageType === 'discord') {
      if (!env.DISCORD_WEBHOOK_URL && !env.DISCORD_BOT_TOKEN) {
        return jsonResponse({ error: 'Discord 未配置，无法完成上传' }, 500);
      }
      const arrayBuffer = await file.arrayBuffer();
      const discordResult = await uploadToDiscord(arrayBuffer, taskData.fileName, taskData.fileType, env);
      if (!discordResult.success) {
        return jsonResponse({ error: 'Discord 上传失败: ' + discordResult.error }, 500);
      }
      const discordId = `discord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      responseFileKey = `discord:${discordId}.${fileExtension}`;
      metadataKey = responseFileKey;
      extraMetadata.discordChannelId = discordResult.channelId;
      extraMetadata.discordMessageId = discordResult.messageId;
      extraMetadata.discordAttachmentId = discordResult.attachmentId;
      extraMetadata.discordUploadMode = discordResult.mode;
      extraMetadata.discordSourceUrl = discordResult.sourceUrl;
    } else if (storageType === 'huggingface') {
      if (!hasHuggingFaceConfig(env)) {
        return jsonResponse({ error: 'HuggingFace 未配置，无法完成上传' }, 500);
      }
      const arrayBuffer = await file.arrayBuffer();
      const hfId = `hf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const hfPath = joinStoragePath(folderPath, `${hfId}.${fileExtension}`);
      const hfResult = await uploadToHuggingFace(arrayBuffer, hfPath, taskData.fileName, env);
      if (!hfResult.success) {
        return jsonResponse({ error: 'HuggingFace 上传失败: ' + hfResult.error }, 500);
      }
      responseFileKey = `hf:${hfId}.${fileExtension}`;
      metadataKey = responseFileKey;
      extraMetadata.hfPath = hfPath;
    } else if (storageType === 'webdav') {
      if (!hasWebDAVConfig(env)) {
        return jsonResponse({ error: 'WebDAV 未配置，无法完成上传' }, 500);
      }
      const arrayBuffer = await file.arrayBuffer();
      const wdId = `wd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const publicId = `${wdId}.${fileExtension}`;
      const webdavPath = joinStoragePath(folderPath, publicId);
      const webdavResult = await uploadToWebDAV(
        arrayBuffer,
        webdavPath,
        file.type || 'application/octet-stream',
        env
      );
      responseFileKey = `webdav:${publicId}`;
      metadataKey = responseFileKey;
      extraMetadata.webdavPath = normalizeWebDAVPath(webdavResult.path || webdavPath);
      extraMetadata.webdavEtag = webdavResult.etag || undefined;
    } else if (storageType === 'github') {
      if (!hasGitHubConfig(env)) {
        return jsonResponse({ error: 'GitHub 未配置，无法完成上传' }, 500);
      }
      const arrayBuffer = await file.arrayBuffer();
      const ghId = `github_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const publicId = `${ghId}.${fileExtension}`;
      const githubStorageKey = joinStoragePath(folderPath, publicId);
      const githubResult = await uploadToGitHub(
        arrayBuffer,
        normalizeGitHubStoragePath(githubStorageKey),
        taskData.fileName,
        file.type || 'application/octet-stream',
        env
      );
      responseFileKey = `github:${publicId}`;
      metadataKey = responseFileKey;
      extraMetadata.githubStorageKey = normalizeGitHubStoragePath(
        githubResult.storagePath || githubStorageKey
      );
      Object.assign(extraMetadata, githubResult.metadata || {});
    } else {
      storageType = 'telegram';
      const result = await uploadToTelegram(file, env);
      if (!result.success) {
        return jsonResponse({ error: result.error }, 500);
      }

      metadataKey = `${result.fileId}.${fileExtension}`;
      taskData.telegramMessageId = result.messageId || taskData.telegramMessageId;

      responseFileKey = await buildTelegramDirectId(
        result.fileId,
        fileExtension,
        taskData.fileName,
        taskData.fileType,
        taskData.fileSize,
        taskData.telegramMessageId,
        env
      );
      extraMetadata.signedLink = shouldUseSignedTelegramLinks(env);
      extraMetadata.telegramFileId = result.fileId;
      telegramNoticePayload = {
        replyToMessageId: taskData.telegramMessageId || undefined,
        directLink: buildTelegramDirectLink(env, responseFileKey, new URL(request.url).origin),
        fileId: result.fileId,
        messageId: taskData.telegramMessageId || undefined,
        fileName: taskData.fileName,
        fileSize: taskData.fileSize,
      };
    }

    const shouldWriteMetadata =
      storageType === 'telegram' ? shouldWriteTelegramMetadata(env) : true;

    if (shouldWriteMetadata && metadataKey) {
      await env.img_url.put(metadataKey, '', {
        metadata: {
          TimeStamp: Date.now(),
          ListType: 'None',
          Label: 'None',
          liked: false,
          fileName: taskData.fileName,
          fileSize: taskData.fileSize,
          chunked: true,
          totalChunks,
          storageType,
          folderPath: folderPath || undefined,
          r2Key: storageType === 'r2' ? metadataKey.replace(/^r2:/, '') : undefined,
          telegramMessageId: storageType === 'telegram' ? taskData.telegramMessageId : undefined,
          ...extraMetadata,
        },
      });
    }

    if (storageType === 'telegram' && telegramNoticePayload) {
      const noticeResult = await sendTelegramUploadNotice(telegramNoticePayload, env);
      if (!noticeResult?.ok && !noticeResult?.skipped) {
        console.warn(
          'Chunked Telegram upload notice failed:',
          noticeResult?.data?.description || noticeResult?.error || 'unknown error'
        );
      }
    }

    await cleanupUploadTask(uploadId, totalChunks, chunkBackend, env);

    return jsonResponse({
      success: true,
      src: `/file/${responseFileKey}`,
      fileName: taskData.fileName,
      fileSize: taskData.fileSize,
    });
  } catch (error) {
    console.error('Complete upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getMissingChunks(uploaded, total) {
  const uploadedSet = new Set(uploaded || []);
  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!uploadedSet.has(i)) missing.push(i);
  }
  return missing;
}

function validateCompletionTarget(storageMode, fileSize) {
  if (storageMode === 'telegram' && fileSize > 20 * MB) {
    return {
      ok: false,
      status: 400,
      code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      message: 'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。更大的文件请切换到 R2/S3/WebDAV/GitHub，或把文件直接发到 Telegram 后使用 Webhook 回链。',
    };
  }
  if (storageMode === 'discord' && fileSize > 25 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'DISCORD_FILE_TOO_LARGE',
      message: 'Discord 默认上传上限按 25MB 处理；更大的文件请使用 R2/S3/WebDAV/GitHub。',
    };
  }
  if (storageMode === 'huggingface' && fileSize > 35 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'HUGGINGFACE_FILE_TOO_LARGE',
      message: 'HuggingFace 普通上传链路建议控制在 35MB 以内；更大的文件请使用 LFS 或其他对象存储。',
    };
  }
  return { ok: true };
}

function isKvWriteMinimized(env) {
  return env.MINIMIZE_KV_WRITES === 'true';
}

function resolveChunkBackend(taskData, env) {
  if (taskData?.chunkBackend === 'r2' && env.R2_BUCKET) return 'r2';
  if (taskData?.chunkBackend === 'kv') return 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function getChunkObjectKey(uploadId, chunkIndex) {
  return `${TEMP_CHUNK_PREFIX}/${uploadId}/${chunkIndex}`;
}

async function readChunkData(uploadId, chunkIndex, chunkBackend, env) {
  if (chunkBackend === 'r2') {
    if (!env.R2_BUCKET) return null;
    const object = await env.R2_BUCKET.get(getChunkObjectKey(uploadId, chunkIndex));
    if (!object) return null;
    return await object.arrayBuffer();
  }
  return await env.img_url.get(`chunk:${uploadId}:${chunkIndex}`, { type: 'arrayBuffer' });
}

async function cleanupUploadTask(uploadId, totalChunks, chunkBackend, env) {
  try {
    if (!isKvWriteMinimized(env)) {
      await env.img_url.delete(`upload:${uploadId}`);
    }

    if (chunkBackend === 'r2' && env.R2_BUCKET) {
      const toDelete = [];
      for (let i = 0; i < totalChunks; i++) {
        toDelete.push(env.R2_BUCKET.delete(getChunkObjectKey(uploadId, i)));
      }
      await Promise.allSettled(toDelete);
      if (isKvWriteMinimized(env)) {
        // Keep kv writes low in minimize mode, rely on TTL for upload task cleanup.
        return;
      }
    }

    if (chunkBackend === 'kv' && !isKvWriteMinimized(env)) {
      for (let i = 0; i < totalChunks; i++) {
        await env.img_url.delete(`chunk:${uploadId}:${i}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

async function uploadToTelegram(file, env) {
  const formData = new FormData();
  formData.append('chat_id', env.TG_Chat_ID);

  const { method: apiEndpoint, field } = getTelegramUploadMethodAndField(file.type);
  formData.append(field, file);

  try {
    const response = await fetch(buildTelegramBotApiUrl(env, apiEndpoint), {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (apiEndpoint === 'sendAudio') {
        const docFormData = new FormData();
        docFormData.append('chat_id', env.TG_Chat_ID);
        docFormData.append('document', file);

        const docResponse = await fetch(buildTelegramBotApiUrl(env, 'sendDocument'), {
          method: 'POST',
          body: docFormData,
        });
        const docData = await docResponse.json();
        if (docResponse.ok && docData.ok) {
          const fileId = pickTelegramFileId(docData);
          if (!fileId) return { success: false, error: 'Telegram 已接收文件，但未返回可用的文件 ID' };
          return {
            success: true,
            fileId,
            messageId: docData?.result?.message_id,
          };
        }
      }
      return { success: false, error: data.description || '上传失败' };
    }

    const fileId = pickTelegramFileId(data);
    if (!fileId) return { success: false, error: 'Telegram 已接收文件，但未返回可用的文件 ID' };
    return {
      success: true,
      fileId,
      messageId: data?.result?.message_id,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function uploadToR2(file, fileExtension, env) {
  const fileId = `r2_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const objectKey = `${fileId}.${fileExtension}`;
  const arrayBuffer = await file.arrayBuffer();

  await env.R2_BUCKET.put(objectKey, arrayBuffer, {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
    },
    customMetadata: {
      fileName: file.name,
      uploadTime: Date.now().toString(),
    },
  });

  return { fileKey: `r2:${objectKey}` };
}

function getFileExtension(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (!ext || ext === String(fileName || '').toLowerCase()) return 'bin';
  return ext.replace(/[^a-z0-9]/g, '') || 'bin';
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

function joinStoragePath(folderPath, fileName) {
  const normalizedFolder = normalizeFolderPath(folderPath);
  if (!normalizedFolder) return fileName;
  return `${normalizedFolder}/${fileName}`;
}

async function buildTelegramDirectId(
  fileId,
  fileExtension,
  fileName,
  mimeType,
  fileSize,
  messageId,
  env
) {
  if (!shouldUseSignedTelegramLinks(env)) {
    return `${fileId}.${fileExtension}`;
  }
  return await createSignedTelegramFileId(
    {
      fileId,
      fileExtension,
      fileName,
      mimeType,
      fileSize,
      messageId,
    },
    env
  );
}
