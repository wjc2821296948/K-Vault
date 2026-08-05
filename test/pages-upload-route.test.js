const assert = require('node:assert');

describe('Cloudflare Pages upload route', function () {
  it('serves the root upload UI for GET /upload without invoking upload POST logic', async function () {
    const { onRequestGet } = await import('../functions/upload.js');
    let requestedPath = '';

    const response = await onRequestGet({
      request: new Request('https://example.com/upload'),
      env: {
        ASSETS: {
          fetch(request) {
            requestedPath = new URL(request.url).pathname;
            return new Response('<!doctype html><title>K-Vault</title>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
          },
        },
      },
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(requestedPath, '/index.html');
    assert.match(await response.text(), /K-Vault/);
  });
});
