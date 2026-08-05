const STORAGE_PREFIXES = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', ''];

const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'folder:'];

function normalizeFolderPath(value = '') {
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

function normalizeFileIdentifier(value = '') {
  const raw = String(value || '').trim();
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
        file.metadata?.id,
        file.metadata?.fileId,
        file.metadata?.fileName
      );
    }
  }
  return Array.from(new Set(values.map(normalizeFileIdentifier).filter(Boolean)));
}

async function getRecordWithKey(env, fileId) {
  const normalizedId = normalizeFileIdentifier(fileId);
  const hasKnownPrefix = STORAGE_PREFIXES.some((prefix) => prefix && normalizedId.startsWith(prefix));
  const candidateKeys = hasKnownPrefix ? [normalizedId] : STORAGE_PREFIXES.map((prefix) => `${prefix}${normalizedId}`);

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) {
      return { record, kvKey: key };
    }
  }

  let cursor = undefined;
  let matched = null;
  let matchCount = 0;
  let guard = 0;
  do {
    const page = await env.img_url.list({ limit: 1000, cursor });
    for (const key of page.keys || []) {
      if (!key?.name || INVALID_PREFIXES.some((prefix) => key.name.startsWith(prefix))) continue;
      const metadata = key.metadata || {};
      if (metadata.folderMarker === true) continue;
      if (String(metadata.fileName || '').trim() !== normalizedId) continue;
      matched = key;
      matchCount += 1;
      if (matchCount > 1) break;
    }
    if (matchCount > 1) break;
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  if (matchCount === 1 && matched?.name) {
    const record = await env.img_url.getWithMetadata(matched.name);
    if (record?.metadata) {
      return { record, kvKey: matched.name };
    }
  }

  return { record: null, kvKey: normalizedId };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const ids = collectMoveIdentifiers(body);
  const targetFolderPath = normalizeFolderPath(body.targetFolderPath || body.folderPath || body.path || '');

  if (ids.length === 0) {
    return jsonResponse({ success: false, error: '缺少要移动的文件 ID。' }, 400);
  }

  let moved = 0;
  const notFound = [];

  for (const id of ids) {
    const { record, kvKey } = await getRecordWithKey(env, id);
    if (!record?.metadata) {
      notFound.push(id);
      continue;
    }

    const metadata = {
      ...(record.metadata || {}),
      folderPath: targetFolderPath,
    };
    await env.img_url.put(kvKey, '', { metadata });
    moved += 1;
  }

  if (moved === 0) {
    return jsonResponse({
      success: false,
      error: '没有找到可移动的文件，目录未变更。请刷新文件列表后重试。',
      targetFolderPath,
      requested: ids.length,
      moved,
      notFound,
    }, 404);
  }

  if (targetFolderPath) {
    await env.img_url.put(`folder:${targetFolderPath}`, '', {
      metadata: {
        folderMarker: true,
        folderPath: targetFolderPath,
        TimeStamp: Date.now(),
      },
    });
  }

  return jsonResponse({
    success: true,
    targetFolderPath,
    requested: ids.length,
    moved,
    notFound,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
