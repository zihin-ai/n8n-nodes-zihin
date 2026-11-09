import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const languageSignal = /(?<![\p{L}\p{N}_])(?:erro|falha|n\u00e3o|voc\u00ea|tamb\u00e9m|invoca\u00e7\u00e3o|configura\u00e7\u00e3o|n\u00facleo|usu\u00e1rio|padr\u00e3o|conex\u00e3o|fun\u00e7\u00e3o|par\u00e2metro)(?![\p{L}\p{N}_])/iu;
const privatePath = /(^|\/)(?:\.env(?:[.-][^/]*)?|\.secrets|\.git|tests?|coverage|node_modules|CLAUDE\.md|AGENTS\.md|ORIGEM\.md|HANDOFF[^/]*)(\/|$)|\.(?:map|log|pem|key)$/i;

function matches(name, glob) {
  const escaped = glob.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

export function validateFiles(root, files, policy) {
  if (!policy.allow?.length || !policy.required?.length) throw new Error('An explicit publication policy is required');
  const errors = [];
  const names = new Set();
  const base = realpathSync(root);
  for (const { path: name } of files) {
    if (path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) {
      errors.push('Unsafe archive path');
      continue;
    }
    if (names.has(name)) errors.push(`Duplicate file: ${name}`);
    names.add(name);
    if (!policy.allow.some(glob => matches(name, glob))) errors.push(`Unexpected file: ${name}`);
    if (privatePath.test(name)) errors.push(`Private or debugging file: ${name}`);
    const resolved = realpathSync(path.join(base, name));
    if (!resolved.startsWith(base + path.sep)) { errors.push(`File outside package: ${name}`); continue; }
    if (/\.(png|jpe?g|ico)$/i.test(name)) continue;
    const content = readFileSync(resolved, 'utf8');
    if (languageSignal.test(content)) errors.push(`Non-English text requires review: ${name}`);
    if (/sourceMappingURL\s*=/.test(content)) errors.push(`Source map reference: ${name}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|npm_)[a-zA-Z0-9]{30,}\b/.test(content)) {
      errors.push(`Credential pattern: ${name}`);
    }
  }
  for (const required of policy.required) if (!names.has(required)) errors.push(`Missing required file: ${required}`);
  const pkg = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
  const targets = [pkg.main, pkg.types, ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {})),
    ...(pkg.n8n?.nodes || []), ...(pkg.n8n?.credentials || [])];
  function addExports(value) {
    if (typeof value === 'string' && value.startsWith('./')) targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(addExports);
  }
  addExports(pkg.exports);
  for (const target of targets.filter(Boolean)) if (!names.has(target.replace(/^\.\//, ''))) errors.push(`Missing entry point: ${target}`);
  return errors;
}

export function check(root = process.cwd()) {
  const policy = JSON.parse(readFileSync(path.join(root, '.publication-policy.json'), 'utf8'));
  const output = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const packs = JSON.parse(output);
  if (packs.length !== 1) throw new Error('Expected exactly one package');
  const errors = validateFiles(root, packs[0].files, policy);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Publication contents verified: ${packs[0].name}, ${packs[0].files.length} files`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) check();
