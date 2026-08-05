const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const { initDatabase } = require('../server/db');
const { loadConfig } = require('../server/lib/config');
const { FileRepository } = require('../server/lib/repos/file-repo');
const { StorageConfigRepository } = require('../server/lib/repos/storage-config-repo');

describe('Docker runtime API v1 parity', function () {
  const originalEnv = { ...process.env };
  let tmpDir;

  beforeEach(function () {
    tmpDir = path.join(__dirname, '..', 'data', `tmp-docker-api-v1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    process.env.CONFIG_ENCRYPTION_KEY = 'docker_api_v1_key_123456';
    process.env.SESSION_SECRET = 'docker_api_v1_secret_123456';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'docker-api-v1.db');
    process.env.BASIC_USER = '';
    process.env.BASIC_PASS = '';
    process.env.TG_BOT_TOKEN = '';
    process.env.TG_CHAT_ID = '';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
  });

  afterEach(function () {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  async function expectStatus(response, status) {
    if (response.status !== status) {
      throw new Error(`Expected ${status}, got ${response.status}: ${await response.text()}`);
    }
  }

  it('creates admin API tokens and uses them for paste endpoints', async function () {
    const app = createApp();

    const createTokenResponse = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smoke', scopes: ['paste', 'read', 'delete'] }),
    }));
    await expectStatus(createTokenResponse, 201);
    const createTokenPayload = await createTokenResponse.json();
    assert.ok(createTokenPayload.token);

    const token = createTokenPayload.token;
    const createPasteResponse = await app.fetch(new Request('http://localhost/api/v1/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: 'hello docker api', language: 'text' }),
    }));
    await expectStatus(createPasteResponse, 201);
    const pastePayload = await createPasteResponse.json();
    assert.ok(pastePayload.paste.id);

    const listResponse = await app.fetch(new Request('http://localhost/api/v1/pastes', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    await expectStatus(listResponse, 200);
    const listPayload = await listResponse.json();
    assert.strictEqual(listPayload.pastes.length, 1);

    const getResponse = await app.fetch(new Request(`http://localhost/api/v1/paste/${pastePayload.paste.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    await expectStatus(getResponse, 200);
    const getPayload = await getResponse.json();
    assert.strictEqual(getPayload.paste.content, 'hello docker api');

    const deleteResponse = await app.fetch(new Request(`http://localhost/api/v1/paste/${pastePayload.paste.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }));
    await expectStatus(deleteResponse, 200);
  });

  it('redirects /s/:slug to the matching file id and preserves query params', async function () {
    const db = initDatabase(process.env.DB_PATH);
    const config = loadConfig(process.env);
    const storageRepo = new StorageConfigRepository(db, config);
    const storage = storageRepo.create({
      name: 'Telegram Test',
      type: 'telegram',
      config: { botToken: 'token', chatId: 'chat' },
      enabled: true,
      isDefault: true,
    });
    const fileRepo = new FileRepository(db);
    fileRepo.create({
      id: 'sample-file.txt',
      storageConfigId: storage.id,
      storageType: 'telegram',
      storageKey: 'sample-file',
      fileName: 'sample-file.txt',
      fileSize: 12,
      mimeType: 'text/plain',
      extra: { shareSlug: 'public-sample' },
    });

    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/s/public-sample?password=secret'));

    assert.strictEqual(response.status, 302);
    assert.strictEqual(
      response.headers.get('location'),
      'http://localhost/file/sample-file.txt?password=secret'
    );
  });

  it('moves files by stable id or unique display name without changing public links', async function () {
    const db = initDatabase(process.env.DB_PATH);
    const config = loadConfig(process.env);
    const storageRepo = new StorageConfigRepository(db, config);
    const storage = storageRepo.create({
      name: 'Telegram Test',
      type: 'telegram',
      config: { botToken: 'token', chatId: 'chat' },
      enabled: true,
      isDefault: true,
    });
    const fileRepo = new FileRepository(db);
    fileRepo.create({
      id: 'telegram-stable-id',
      storageConfigId: storage.id,
      storageType: 'telegram',
      storageKey: 'telegram-stable-id',
      fileName: 'photo-display-name.webp',
      fileSize: 12,
      mimeType: 'image/webp',
    });

    const app = createApp();
    const moveResponse = await app.fetch(new Request('http://localhost/api/manage/files/move-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ fileName: 'photo-display-name.webp' }],
        targetFolderPath: '图片',
      }),
    }));
    await expectStatus(moveResponse, 200);
    const movePayload = await moveResponse.json();
    assert.strictEqual(movePayload.moved, 1);

    const moved = fileRepo.getById('telegram-stable-id');
    assert.strictEqual(moved.metadata.folderPath, '图片');
    assert.strictEqual(moved.id, 'telegram-stable-id');
    assert.strictEqual(`/file/${moved.id}`, '/file/telegram-stable-id');

    const foldersResponse = await app.fetch(new Request('http://localhost/api/manage/folders'));
    await expectStatus(foldersResponse, 200);
    const foldersPayload = await foldersResponse.json();
    assert.ok(foldersPayload.folders.some((folder) => folder.path === '图片'));
  });

  it('rejects folder moves when no requested files can be resolved', async function () {
    const app = createApp();
    const moveResponse = await app.fetch(new Request('http://localhost/api/manage/files/move-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['missing-file-id'],
        targetFolderPath: '图片',
      }),
    }));

    await expectStatus(moveResponse, 404);
    const payload = await moveResponse.json();
    assert.strictEqual(payload.success, false);
    assert.match(payload.error, /没有找到可移动的文件/);
  });
});
