const assert = require('node:assert');

function createMockKv(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([name, value]) => [
      name,
      {
        value: value.value || '',
        metadata: { ...(value.metadata || {}) },
      },
    ]),
  );

  return {
    async getWithMetadata(name) {
      const item = store.get(name);
      if (!item) return { value: null, metadata: null };
      return { value: item.value, metadata: { ...item.metadata } };
    },
    async put(name, value, options = {}) {
      store.set(name, {
        value,
        metadata: { ...(options.metadata || {}) },
      });
    },
    async list() {
      return {
        list_complete: true,
        keys: Array.from(store.entries()).map(([name, item]) => ({
          name,
          metadata: { ...item.metadata },
        })),
      };
    },
    snapshot() {
      return store;
    },
  };
}

describe('Cloudflare manage file folder moves', function () {
  it('moves by unique display name and creates a folder marker without changing the file key', async function () {
    const { onRequestPost } = await import('../functions/api/manage/files/move-folder.js');
    const img_url = createMockKv({
      'webdav:stable-id': {
        metadata: {
          fileName: 'photo.webp',
          TimeStamp: 1700000000000,
          storageType: 'webdav',
          webdavPath: 'photo.webp',
        },
      },
    });

    const response = await onRequestPost({
      env: { img_url },
      request: new Request('https://example.com/api/manage/files/move-folder', {
        method: 'POST',
        body: JSON.stringify({
          ids: ['photo.webp'],
          targetFolderPath: '图片',
        }),
      }),
    });
    const payload = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.success, true);
    assert.strictEqual(payload.moved, 1);

    const moved = img_url.snapshot().get('webdav:stable-id');
    assert.strictEqual(moved.metadata.folderPath, '图片');
    assert.strictEqual(moved.metadata.webdavPath, 'photo.webp');
    assert.ok(img_url.snapshot().has('folder:图片'));
  });

  it('rejects moves when no requested file can be resolved', async function () {
    const { onRequestPost } = await import('../functions/api/manage/files/move-folder.js');
    const img_url = createMockKv();

    const response = await onRequestPost({
      env: { img_url },
      request: new Request('https://example.com/api/manage/files/move-folder', {
        method: 'POST',
        body: JSON.stringify({
          ids: ['missing.webp'],
          targetFolderPath: '图片',
        }),
      }),
    });
    const payload = await response.json();

    assert.strictEqual(response.status, 404);
    assert.strictEqual(payload.success, false);
    assert.match(payload.error, /没有找到可移动的文件/);
  });
});
