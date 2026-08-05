#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const serviceName = process.env.DOCKER_SERVICE || 'k-vault';

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  });

  return {
    code: Number(result.status == null ? 1 : result.status),
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function runComposeExec(script) {
  return runCommand('docker', ['compose', 'exec', '-T', serviceName, 'sh', '-lc', script]);
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  const timeout = Math.max(0, Number(ms) || 0);
  if (timeout === 0) return;
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${timeout})`], {
    stdio: 'ignore',
  });
}

function waitForApi(maxAttempts = 60, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const health = runComposeExec('wget -qO- http://localhost:8080/api/health');
    if (health.code === 0) {
      return true;
    }
    sleepMs(intervalMs);
  }
  return false;
}

function readStatus() {
  const response = runComposeExec('wget -qO- http://localhost:8080/api/status');
  if (response.code !== 0) {
    return { ok: false, error: response.stderr || response.stdout || 'status request failed', data: null };
  }

  const parsed = parseJson(response.stdout);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'status response is not valid JSON', data: null };
  }

  return { ok: true, error: '', data: parsed };
}

function readProfileTypes() {
  const script = "cd /app/server && node -e \"const { createContainer }=require('./lib/container'); const c=createContainer(process.env); console.log(JSON.stringify(c.storageRepo.list(false).map(x=>x.type)));\"";
  const response = runComposeExec(script);
  if (response.code !== 0) {
    return { ok: false, error: response.stderr || response.stdout || 'profile query failed', types: [] };
  }

  const parsed = parseJson(response.stdout);
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'profile query returned invalid JSON', types: [] };
  }

  return { ok: true, error: '', types: parsed };
}

function readPublicText(pathname) {
  const response = runComposeExec(`wget -qO- http://localhost:8080${pathname}`);
  if (response.code !== 0) {
    return { ok: false, error: response.stderr || response.stdout || `${pathname} request failed`, text: '' };
  }

  return { ok: true, error: '', text: response.stdout };
}

function assertConfigured(status, key, errors) {
  const item = status[key] || {};
  if (item.configured !== true) {
    errors.push(key + ' should be configured=true, got configured=' + String(item.configured));
  }
  if (item.enabled !== true) {
    errors.push(key + ' should be enabled=true, got enabled=' + String(item.enabled));
  }
}

function main() {
  process.stdout.write('Running Docker CI smoke checks for storage bootstrap...\n');

  const composePs = runCommand('docker', ['compose', 'ps']);
  if (composePs.code !== 0) {
    process.stderr.write('docker compose ps failed: ' + (composePs.stderr || composePs.stdout) + '\n');
    process.exit(2);
    return;
  }

  if (!waitForApi()) {
    process.stderr.write('API did not become ready in time.\n');
    process.exit(2);
    return;
  }

  const statusResult = readStatus();
  if (!statusResult.ok) {
    process.stderr.write('Failed to read /api/status: ' + statusResult.error + '\n');
    process.exit(2);
    return;
  }

  const profileResult = readProfileTypes();
  if (!profileResult.ok) {
    process.stderr.write('Failed to inspect storage profiles: ' + profileResult.error + '\n');
    process.exit(2);
    return;
  }

  const errors = [];
  const status = statusResult.data;
  const rootPage = readPublicText('/');
  const uploadPage = readPublicText('/upload');

  assertConfigured(status, 'huggingface', errors);
  assertConfigured(status, 'github', errors);

  if (!rootPage.ok || !rootPage.text.includes('K-Vault')) {
    errors.push('public / should serve the K-Vault static UI through nginx');
  }

  if (!uploadPage.ok || !uploadPage.text.includes('K-Vault')) {
    errors.push('GET /upload should render the same root upload UI as Cloudflare Pages');
  }

  const typeSet = new Set(profileResult.types);
  if (!typeSet.has('huggingface')) {
    errors.push('storage profile list is missing huggingface');
  }
  if (!typeSet.has('github')) {
    errors.push('storage profile list is missing github');
  }

  if (errors.length > 0) {
    process.stderr.write('Docker CI smoke checks failed:\n- ' + errors.join('\n- ') + '\n');
    process.stderr.write('Status snapshot:\n' + JSON.stringify({
      huggingface: status.huggingface,
      github: status.github,
      profileTypes: profileResult.types,
    }, null, 2) + '\n');
    process.exit(2);
    return;
  }

  process.stdout.write('Docker CI smoke checks passed.\n');
  process.stdout.write(JSON.stringify({
    huggingface: status.huggingface,
    github: status.github,
    profileTypes: profileResult.types,
  }, null, 2) + '\n');
}

main();
