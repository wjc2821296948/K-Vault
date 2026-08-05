#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const serviceName = process.env.DOCKER_SERVICE || 'k-vault';

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
  });

  return {
    code: Number(result.status == null ? 1 : result.status),
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function runDockerComposeExec(script) {
  return runCommand('docker', ['compose', 'exec', '-T', serviceName, 'sh', '-lc', script]);
}

function runDockerComposeCurl(pathname) {
  const script = `wget -qO- http://localhost:8080${pathname}`;
  return runDockerComposeExec(script);
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function truncate(text, max = 260) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function hasAnyValue(envLines, keys) {
  const normalized = envLines.map((line) => line.trim()).filter(Boolean);
  return keys.some((key) => normalized.some((line) => line.startsWith(`${key}=`) && line.split('=').slice(1).join('=').trim() !== ''));
}

function checkDockerComposeReady() {
  const ps = runCommand('docker', ['compose', 'ps']);
  if (ps.code !== 0) {
    return {
      ok: false,
      message: 'docker compose ps failed',
      detail: truncate(ps.stderr || ps.stdout || 'Unknown error'),
    };
  }

  const escapedServiceName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasService = new RegExp(`\\b${escapedServiceName}\\b|\\bkvault\\b`, 'i').test(ps.stdout);
  return {
    ok: hasService,
    message: hasService ? 'docker compose is running' : `${serviceName} service not found in docker compose ps`,
    detail: truncate(ps.stdout, 500),
  };
}

function collectStatus() {
  const response = runDockerComposeCurl('/api/status');
  if (response.code !== 0) {
    return {
      ok: false,
      message: `failed to query /api/status inside ${serviceName} container`,
      detail: truncate(response.stderr || response.stdout || 'Unknown error'),
      raw: null,
    };
  }

  const json = parseJson(response.stdout);
  if (!json) {
    return {
      ok: false,
      message: 'api/status returned non-JSON content',
      detail: truncate(response.stdout || response.stderr || 'Unknown error'),
      raw: null,
    };
  }

  return {
    ok: true,
    message: 'status fetched',
    detail: '',
    raw: json,
  };
}

function collectEnv() {
  const command = "env | grep -E 'HF_|HUGGINGFACE|GITHUB_|GH_|DEFAULT_STORAGE_TYPE'";
  const response = runDockerComposeExec(command);
  const lines = response.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  const hasHF = hasAnyValue(lines, ['HF_TOKEN', 'HUGGINGFACE_TOKEN', 'HF_API_TOKEN'])
    && hasAnyValue(lines, ['HF_REPO', 'HUGGINGFACE_REPO', 'HF_DATASET_REPO']);
  const hasGH = hasAnyValue(lines, ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT'])
    && hasAnyValue(lines, ['GITHUB_REPO', 'GH_REPO', 'GITHUB_REPOSITORY']);

  return {
    ok: response.code === 0,
    message: response.code === 0 ? 'env read completed' : 'env read failed',
    detail: truncate(response.code === 0 ? lines.join('\n') : (response.stderr || response.stdout || 'Unknown error'), 900),
    hasHF,
    hasGH,
  };
}

function collectConnectivity() {
  const github = runDockerComposeExec('wget -S --spider https://api.github.com 2>&1 | head -n 20');
  const huggingFace = runDockerComposeExec('wget -S --spider https://huggingface.co 2>&1 | head -n 20');

  return {
    github: {
      ok: github.code === 0,
      detail: truncate(github.stdout || github.stderr || 'Unknown error', 700),
    },
    huggingface: {
      ok: huggingFace.code === 0,
      detail: truncate(huggingFace.stdout || huggingFace.stderr || 'Unknown error', 700),
    },
  };
}

function collectBootstrapProfiles() {
  const script = "cd /app/server && node -e \"const { createContainer }=require('./lib/container'); const c=createContainer(process.env); console.log(JSON.stringify(c.storageRepo.list(false).map(x=>({type:x.type,name:x.name,enabled:x.enabled,isDefault:x.isDefault})), null, 2));\"";
  const response = runDockerComposeExec(script);
  if (response.code !== 0) {
    return {
      ok: false,
      message: 'failed to inspect storage bootstrap profiles',
      detail: truncate(response.stderr || response.stdout || 'Unknown error'),
      profiles: [],
    };
  }

  const profiles = parseJson(response.stdout);
  if (!Array.isArray(profiles)) {
    return {
      ok: false,
      message: 'unexpected profile output format',
      detail: truncate(response.stdout || 'Unknown error'),
      profiles: [],
    };
  }

  return {
    ok: true,
    message: 'profile inspection completed',
    detail: '',
    profiles,
  };
}

function diagnose(results) {
  const issues = [];

  const status = results.status.raw || {};
  const hfStatus = status.huggingface || {};
  const ghStatus = status.github || {};

  if (!results.compose.ok) {
    issues.push(`Docker compose unavailable or ${serviceName} service missing.`);
    return issues;
  }

  if (!results.status.ok) {
    issues.push(`Cannot read /api/status from ${serviceName} container.`);
    return issues;
  }

  if (!results.env.ok) {
    issues.push('Cannot read env vars from api container.');
  }

  if (!results.env.hasHF) {
    issues.push('HuggingFace env pair missing in container (token/repo).');
  }

  if (!results.env.hasGH) {
    issues.push('GitHub env pair missing in container (token/repo).');
  }

  const profileTypes = new Set(results.profiles.profiles.map((item) => item.type));
  if (!profileTypes.has('huggingface') && results.env.hasHF) {
    issues.push('HuggingFace profile not bootstrapped into storage_configs yet. Restart/rebuild needed.');
  }
  if (!profileTypes.has('github') && results.env.hasGH) {
    issues.push('GitHub profile not bootstrapped into storage_configs yet. Restart/rebuild needed.');
  }

  if (!results.connectivity.github.ok && ghStatus.configured) {
    issues.push('GitHub connectivity from container failed (DNS/proxy/firewall or upstream block).');
  }

  if (!results.connectivity.huggingface.ok && hfStatus.configured) {
    issues.push('HuggingFace connectivity from container failed (DNS/proxy/firewall or upstream block).');
  }

  if (hfStatus.configured && hfStatus.connected === false && results.connectivity.huggingface.ok) {
    issues.push('HuggingFace is configured but not connected. Check token scope/repo id/privacy.');
  }

  if (ghStatus.configured && ghStatus.connected === false && results.connectivity.github.ok) {
    issues.push('GitHub is configured but not connected. Check token scope/repo/mode/releaseTag.');
  }

  return issues;
}

function printSection(title, body) {
  process.stdout.write(`\n[${title}]\n${body}\n`);
}

function main() {
  process.stdout.write('K-Vault Docker Storage Doctor\n');

  const compose = checkDockerComposeReady();
  const status = compose.ok ? collectStatus() : { ok: false, message: 'skipped', detail: '' };
  const env = compose.ok ? collectEnv() : { ok: false, message: 'skipped', detail: '', hasHF: false, hasGH: false };
  const connectivity = compose.ok
    ? collectConnectivity()
    : { github: { ok: false, detail: 'skipped' }, huggingface: { ok: false, detail: 'skipped' } };
  const profiles = compose.ok
    ? collectBootstrapProfiles()
    : { ok: false, message: 'skipped', detail: '', profiles: [] };

  const results = {
    compose,
    status,
    env,
    connectivity,
    profiles,
  };

  const hfStatus = status.raw?.huggingface || {};
  const ghStatus = status.raw?.github || {};

  printSection('compose', `${compose.ok ? 'OK' : 'FAIL'} - ${compose.message}\n${compose.detail}`);
  printSection(
    'status-summary',
    [
      `huggingface: configured=${Boolean(hfStatus.configured)} connected=${Boolean(hfStatus.connected)} message=${hfStatus.message || ''}`,
      `github: configured=${Boolean(ghStatus.configured)} connected=${Boolean(ghStatus.connected)} message=${ghStatus.message || ''}`,
    ].join('\n')
  );
  printSection('env', `${env.ok ? 'OK' : 'FAIL'} - hasHF=${env.hasHF} hasGH=${env.hasGH}\n${env.detail}`);
  printSection('connectivity-github', `${connectivity.github.ok ? 'OK' : 'FAIL'}\n${connectivity.github.detail}`);
  printSection('connectivity-huggingface', `${connectivity.huggingface.ok ? 'OK' : 'FAIL'}\n${connectivity.huggingface.detail}`);
  printSection(
    'profiles',
    profiles.ok
      ? JSON.stringify(profiles.profiles, null, 2)
      : `FAIL - ${profiles.message}\n${profiles.detail}`
  );

  const issues = diagnose(results);

  if (issues.length === 0) {
    printSection('diagnosis', 'PASS - no obvious issue found for Docker GitHub/HuggingFace wiring.');
    process.exitCode = 0;
    return;
  }

  printSection('diagnosis', `FAIL - ${issues.length} issue(s) detected:\n- ${issues.join('\n- ')}`);
  printSection(
    'next-actions',
    [
      '1) Confirm .env includes token+repo pairs for both providers (or alias vars).',
      '2) Pull/restart: docker compose pull ; docker compose up -d',
      '3) Re-run: npm run docker:doctor',
      '4) If still failing with configured=true, verify token scopes and repository visibility.',
    ].join('\n')
  );
  process.exitCode = 2;
}

main();
