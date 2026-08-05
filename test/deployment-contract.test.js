const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment entrypoint contract', function () {
  const root = path.resolve(__dirname, '..');

  it('keeps Cloudflare Pages deployment rooted at repository static pages', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    assert.match(pkg.scripts.build, /No build step required/);
    assert.doesNotMatch(pkg.scripts.build, /frontend|vite|dist/);
    assert.strictEqual(pkg.scripts['pages:deploy'], 'npx wrangler pages deploy .');
  });

  it('does not keep old frontend build assets as deployable UI', function () {
    const removedPaths = [
      'frontend/index.html',
      'frontend/landing',
      'frontend/src',
      'frontend/package.json',
      'frontend/vite.config.js',
      'frontend/Dockerfile',
      'frontend/nginx.conf',
      'server/Dockerfile',
      '_nuxt',
    ];

    for (const relativePath of removedPaths) {
      assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
    }
  });

  it('serves Docker from the same root static pages and proxies share routes', function () {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const entrypoint = fs.readFileSync(path.join(root, 'docker', 'entrypoint.sh'), 'utf8');
    const nginx = fs.readFileSync(path.join(root, 'docker', 'nginx.conf'), 'utf8');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const imageWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker-image.yml'), 'utf8');

    assert.match(dockerfile, /COPY index\.html admin\.html gallery\.html webdav\.html/);
    assert.doesNotMatch(dockerfile, /_nuxt|frontend\/dist|frontend\/landing/);
    assert.match(dockerfile, /ENTRYPOINT \["k-vault-entrypoint"\]/);
    assert.match(entrypoint, /ensure_secret CONFIG_ENCRYPTION_KEY/);
    assert.match(entrypoint, /runtime\.env/);
    assert.match(nginx, /location\s+\/s\//);
    assert.match(nginx, /GET\/HEAD render the root upload UI/);
    assert.match(compose, /ghcr\.io\/katelya77\/k-vault:latest/);
    assert.match(compose, /required:\s+false/);
    assert.doesNotMatch(compose, /kvault-api|kvault-web|frontend\/Dockerfile|server\/Dockerfile/);
    assert.match(imageWorkflow, /IMAGE_NAME: k-vault/);
    assert.doesNotMatch(imageWorkflow, /k-vault-api|k-vault-web|matrix:/);
  });
});
