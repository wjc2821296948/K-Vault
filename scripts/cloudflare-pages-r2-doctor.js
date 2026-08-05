#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const defaultConfigPath = path.join(repoRoot, 'wrangler.jsonc');
const allowedJurisdictions = new Set(['eu', 'fedramp']);
const invalidJurisdictionHints = new Set(['auto', 'automatic', 'default', 'global', 'none', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);

function usage() {
  console.log(`Usage:
  node scripts/cloudflare-pages-r2-doctor.js [--check] [--write]

Options:
  --check                         Validate an existing wrangler.jsonc.
  --write                         Write a wrangler.jsonc from environment or CLI values.
  --config <path>                 Config path. Defaults to ./wrangler.jsonc.
  --project-name <name>           Cloudflare Pages project name. Defaults to k-vault.
  --output-dir <path>             Pages build output directory. Defaults to ".".
  --compatibility-date <date>     Workers compatibility date. Defaults to today.
  --kv-id <id>                    KV namespace id for binding img_url.
  --r2-bucket <name>              R2 bucket name for binding R2_BUCKET.
  --r2-jurisdiction <value>       Optional R2 jurisdiction. Valid values: eu, fedramp.
  --allow-missing-kv              Allow --write without the img_url KV binding.

Environment fallbacks:
  CF_PAGES_PROJECT / PAGES_PROJECT_NAME
  KV_NAMESPACE_ID / IMG_URL_KV_NAMESPACE_ID
  R2_BUCKET_NAME / R2_BUCKET
  R2_BUCKET_JURISDICTION`);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function readArgValue(argv, index, name) {
  const current = argv[index];
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) return { value: current.slice(prefix.length), nextIndex: index };
  if (argv[index + 1] && !argv[index + 1].startsWith('--')) return { value: argv[index + 1], nextIndex: index + 1 };
  throw new Error(`Missing value for ${name}`);
}

function parseArgs(argv) {
  const options = {
    mode: 'print',
    configPath: defaultConfigPath,
    projectName: process.env.CF_PAGES_PROJECT || process.env.PAGES_PROJECT_NAME || 'k-vault',
    outputDir: process.env.PAGES_BUILD_OUTPUT_DIR || '.',
    compatibilityDate: process.env.PAGES_COMPATIBILITY_DATE || todayUtc(),
    kvId: process.env.KV_NAMESPACE_ID || process.env.IMG_URL_KV_NAMESPACE_ID || '',
    r2Bucket: process.env.R2_BUCKET_NAME || process.env.R2_BUCKET || 'k-vault-files',
    r2Jurisdiction: process.env.R2_BUCKET_JURISDICTION || '',
    allowMissingKv: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--check') {
      options.mode = 'check';
      continue;
    }
    if (arg === '--write') {
      options.mode = 'write';
      continue;
    }
    if (arg === '--allow-missing-kv') {
      options.allowMissingKv = true;
      continue;
    }

    const valueOptions = new Map([
      ['--config', 'configPath'],
      ['--project-name', 'projectName'],
      ['--output-dir', 'outputDir'],
      ['--compatibility-date', 'compatibilityDate'],
      ['--kv-id', 'kvId'],
      ['--r2-bucket', 'r2Bucket'],
      ['--r2-jurisdiction', 'r2Jurisdiction'],
    ]);

    const matchedName = [...valueOptions.keys()].find((name) => arg === name || arg.startsWith(`${name}=`));
    if (matchedName) {
      const parsed = readArgValue(argv, i, matchedName);
      const key = valueOptions.get(matchedName);
      options[key] = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.configPath = path.resolve(repoRoot, options.configPath);
  options.r2Jurisdiction = String(options.r2Jurisdiction || '').trim().toLowerCase();
  return options;
}

function validateJurisdiction(value) {
  if (!value) return [];
  if (allowedJurisdictions.has(value)) return [];

  const hint = invalidJurisdictionHints.has(value)
    ? 'This value is a location hint or automatic placement marker, not an R2 jurisdiction.'
    : 'Only eu and fedramp are valid R2 jurisdiction values.';
  return [`Invalid R2 jurisdiction "${value}". ${hint}`];
}

function buildConfig(options) {
  const errors = [
    ...validateJurisdiction(options.r2Jurisdiction),
  ];

  if (!options.projectName) errors.push('Missing Pages project name.');
  if (!options.outputDir) errors.push('Missing pages_build_output_dir.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.compatibilityDate)) {
    errors.push('compatibility_date must use YYYY-MM-DD format.');
  }
  if (!options.r2Bucket) errors.push('Missing R2 bucket name.');

  if (errors.length) {
    const error = new Error(errors.join('\n'));
    error.validationErrors = errors;
    throw error;
  }

  const config = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: options.projectName,
    pages_build_output_dir: options.outputDir,
    compatibility_date: options.compatibilityDate,
  };

  if (options.kvId) {
    config.kv_namespaces = [
      {
        binding: 'img_url',
        id: options.kvId,
      },
    ];
  }

  const r2Bucket = {
    binding: 'R2_BUCKET',
    bucket_name: options.r2Bucket,
  };

  if (options.r2Jurisdiction) {
    r2Bucket.jurisdiction = options.r2Jurisdiction;
  }

  config.r2_buckets = [r2Bucket];

  return config;
}

function renderJsonc(config, options) {
  const warnings = [];
  if (!options.kvId) {
    warnings.push('KV_NAMESPACE_ID was not provided, so the img_url KV binding is not included.');
  }
  if (!options.r2Jurisdiction) {
    warnings.push('No R2 jurisdiction will be written. This is correct for normal buckets created with Automatic placement.');
  }

  const lines = [
    '// Cloudflare Pages configuration for K-Vault.',
    '// Keep this file in sync with the Pages dashboard. When present, it becomes the source of truth for these settings.',
  ];

  for (const warning of warnings) {
    lines.push(`// WARNING: ${warning}`);
  }

  lines.push(JSON.stringify(config, null, 2));
  lines.push('');
  return lines.join('\n');
}

function stripJsonComments(input) {
  let output = '';
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }

    output += char;
  }

  return output.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonc(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(stripJsonComments(content));
}

function validateConfig(config) {
  const issues = [];
  if (!config || typeof config !== 'object') {
    return ['Config is not a JSON object.'];
  }
  if (!config.name) issues.push('Missing required "name".');
  if (!config.pages_build_output_dir) issues.push('Missing required "pages_build_output_dir".');
  if (!config.compatibility_date) issues.push('Missing required "compatibility_date".');

  const r2Bindings = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const nativeR2 = r2Bindings.find((binding) => binding && binding.binding === 'R2_BUCKET');
  if (!nativeR2) {
    issues.push('Missing r2_buckets binding named R2_BUCKET.');
  } else {
    if (!nativeR2.bucket_name) issues.push('R2_BUCKET binding is missing bucket_name.');
    issues.push(...validateJurisdiction(String(nativeR2.jurisdiction || '').trim().toLowerCase()));
  }

  const kvBindings = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
  if (!kvBindings.some((binding) => binding && binding.binding === 'img_url')) {
    issues.push('img_url KV binding is not present. K-Vault image metadata and UI config need this binding.');
  }

  return issues;
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    usage();
    return;
  }

  if (options.mode === 'check') {
    if (!fs.existsSync(options.configPath)) {
      throw new Error(`Config file not found: ${options.configPath}`);
    }
    const config = parseJsonc(options.configPath);
    const issues = validateConfig(config);
    if (issues.length) {
      console.error('Cloudflare Pages R2 config check failed:');
      for (const issue of issues) console.error(`- ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log('Cloudflare Pages R2 config check passed.');
    return;
  }

  const config = buildConfig(options);
  const rendered = renderJsonc(config, options);

  if (options.mode === 'write') {
    if (!options.kvId && !options.allowMissingKv) {
      throw new Error('Refusing to write wrangler.jsonc without img_url KV binding. Provide --kv-id <id> or pass --allow-missing-kv intentionally.');
    }
    fs.writeFileSync(options.configPath, rendered, 'utf8');
    console.log(`Wrote ${path.relative(repoRoot, options.configPath)}`);
    console.log('Review the file before committing. Cloudflare Pages will use it as the source of truth for these settings.');
    return;
  }

  process.stdout.write(rendered);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
