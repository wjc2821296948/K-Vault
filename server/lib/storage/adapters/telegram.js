const { getExtension } = require('../common');

function normalizeApiBase(raw) {
  if (!raw) return 'https://api.telegram.org';
  try {
    return new URL(String(raw)).toString().replace(/\/+$/, '');
  } catch {
    return 'https://api.telegram.org';
  }
}

function buildBotApiUrl(config, method) {
  const base = normalizeApiBase(config.apiBase);
  const token = config.botToken;
  return `${base}/bot${token}/${method}`;
}

function buildFileUrl(config, filePath) {
  const base = normalizeApiBase(config.apiBase);
  return `${base}/file/bot${config.botToken}/${String(filePath || '').replace(/^\/+/, '')}`;
}

function pickUploadMethod(mimeType = '') {
  const type = String(mimeType).toLowerCase();
  if (type.startsWith('image/')) return { method: 'sendDocument', field: 'document' };
  if (type.startsWith('audio/')) return { method: 'sendAudio', field: 'audio' };
  if (type.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  return { method: 'sendDocument', field: 'document' };
}

function pickFileId(result) {
  if (!result) return null;
  if (Array.isArray(result.photo) && result.photo.length > 0) {
    return result.photo[result.photo.length - 1].file_id;
  }
  if (result.document?.file_id) return result.document.file_id;
  if (result.video?.file_id) return result.video.file_id;
  if (result.audio?.file_id) return result.audio.file_id;
  if (result.voice?.file_id) return result.voice.file_id;
  if (result.sticker?.file_id) return result.sticker.file_id;
  if (result.animation?.file_id) return result.animation.file_id;
  if (result.video_note?.file_id) return result.video_note.file_id;
  return null;
}

class TelegramStorageAdapter {
  constructor(config) {
    this.type = 'telegram';
    this.config = {
      botToken: config.botToken,
      chatId: config.chatId,
      apiBase: config.apiBase,
    };
  }

  validate() {
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error('Telegram 存储需要配置 botToken 和 chatId。');
    }
  }

  async testConnection() {
    this.validate();
    const response = await fetch(buildBotApiUrl(this.config, 'getMe'));
    const json = await response.json().catch(() => ({}));
    const detail = typeof json?.description === 'string' && json.description
      ? json.description
      : (typeof json?.message === 'string' && json.message ? json.message : '');

    return {
      connected: Boolean(response.ok && json.ok),
      status: response.status,
      detail: detail || (json?.ok ? 'ok' : 'Telegram API request failed'),
      raw: json,
      botUsername: json?.result?.username || '',
    };
  }

  async upload({ buffer, fileName, mimeType, fileSize }) {
    this.validate();

    // Telegram Bot API practical limits: upload 50MB (default cloud bot api), download 20MB.
    // We choose stability-first: enforce 50MB upload ceiling here.
    const maxSize = 50 * 1024 * 1024;
    if (fileSize > maxSize) {
      throw new Error('Telegram 上传超过 50MB 上限。');
    }

    const { method, field } = pickUploadMethod(mimeType);
    const extension = getExtension(fileName, mimeType, 'bin');
    const normalizedName = fileName || `upload.${extension}`;

    const formData = new FormData();
    formData.append('chat_id', this.config.chatId);
    formData.append(field, new File([buffer], normalizedName, { type: mimeType || 'application/octet-stream' }));

    let response = await fetch(buildBotApiUrl(this.config, method), {
      method: 'POST',
      body: formData,
    });

    let json = await response.json().catch(() => ({}));

    // Fallback audio to document when Telegram media type checks reject.
    if ((!response.ok || !json.ok) && method === 'sendAudio') {
      const fallbackForm = new FormData();
      fallbackForm.append('chat_id', this.config.chatId);
      fallbackForm.append('document', new File([buffer], normalizedName, { type: mimeType || 'application/octet-stream' }));
      response = await fetch(buildBotApiUrl(this.config, 'sendDocument'), {
        method: 'POST',
        body: fallbackForm,
      });
      json = await response.json().catch(() => ({}));
    }

    if (!response.ok || !json.ok) {
      throw new Error(json.description || `Telegram upload failed (${response.status})`);
    }

    const fileId = pickFileId(json.result);
    if (!fileId) {
      throw new Error('Telegram 已接收文件，但未返回可用的 file_id。');
    }

    return {
      storageKey: fileId,
      metadata: {
        telegramFileId: fileId,
        telegramMessageId: json.result?.message_id || null,
      },
    };
  }

  async download({ storageKey, metadata = {}, range }) {
    this.validate();

    const fileId = metadata.telegramFileId || storageKey;
    const infoResponse = await fetch(
      `${buildBotApiUrl(this.config, 'getFile')}?file_id=${encodeURIComponent(fileId)}`,
      { method: 'GET' }
    );
    const infoJson = await infoResponse.json().catch(() => ({}));

    if (!infoResponse.ok || !infoJson.ok || !infoJson.result?.file_path) {
      throw new Error(infoJson.description || 'Telegram 获取文件信息失败。');
    }

    const headers = {};
    if (range) headers.Range = range;

    const response = await fetch(buildFileUrl(this.config, infoJson.result.file_path), {
      method: 'GET',
      headers,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Telegram 下载失败（${response.status}）`);
    }

    return response;
  }

  async delete({ metadata = {}, storageKey }) {
    this.validate();
    const messageId = metadata.telegramMessageId;
    if (!messageId) return false;

    const response = await fetch(buildBotApiUrl(this.config, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        message_id: Number(messageId),
      }),
    });

    const json = await response.json().catch(() => ({}));
    return Boolean(response.ok && json.ok);
  }
}

module.exports = {
  TelegramStorageAdapter,
};
