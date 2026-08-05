const assert = require('node:assert');
const { TelegramStorageAdapter } = require('../server/lib/storage/adapters/telegram');

describe('Telegram upload routing', function () {
  it('uploads image MIME types as documents in Cloudflare Pages helpers', async function () {
    const { getTelegramUploadMethodAndField, pickTelegramFileId } = await import('../functions/utils/telegram.js');

    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      assert.deepStrictEqual(getTelegramUploadMethodAndField(mimeType), {
        method: 'sendDocument',
        field: 'document',
      });
    }

    assert.strictEqual(
      pickTelegramFileId({
        ok: true,
        result: {
          message_id: 456,
          sticker: { file_id: 'telegram-webp-sticker-id' },
        },
      }),
      'telegram-webp-sticker-id',
    );
  });

  it('uploads image MIME types as documents in the Docker adapter', async function () {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedDocument = null;

    globalThis.fetch = async (url, options = {}) => {
      capturedUrl = String(url);
      capturedDocument = options.body?.get('document') || null;
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 123,
            document: { file_id: 'telegram-document-id' },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    try {
      const adapter = new TelegramStorageAdapter({
        botToken: 'test-token',
        chatId: 'test-chat',
      });

      const result = await adapter.upload({
        buffer: new Uint8Array([1, 2, 3]).buffer,
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 3,
      });

      assert.ok(capturedUrl.endsWith('/sendDocument'));
      assert.ok(capturedDocument instanceof File);
      assert.strictEqual(capturedDocument.name, 'photo.png');
      assert.strictEqual(result.storageKey, 'telegram-document-id');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts Telegram sticker responses for WebP uploads in the Docker adapter', async function () {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 456,
          sticker: { file_id: 'telegram-webp-sticker-id' },
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    try {
      const adapter = new TelegramStorageAdapter({
        botToken: 'test-token',
        chatId: 'test-chat',
      });

      const result = await adapter.upload({
        buffer: new Uint8Array([1, 2, 3]).buffer,
        fileName: 'sticker.webp',
        mimeType: 'image/webp',
        fileSize: 3,
      });

      assert.strictEqual(result.storageKey, 'telegram-webp-sticker-id');
      assert.strictEqual(result.metadata.telegramFileId, 'telegram-webp-sticker-id');
      assert.strictEqual(result.metadata.telegramMessageId, 456);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
