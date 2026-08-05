const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('WebDAV page contract', function () {
  it('handles legacy array upload responses for URL uploads and targets WebDAV storage', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'webdav.html'), 'utf8');

    assert.match(html, /storageMode:\s*"webdav"/);
    assert.match(html, /Array\.isArray\(payload\)\s*\?\s*payload\[0\]\s*:\s*payload/);
    assert.match(html, /URL 上传成功/);
  });
});
