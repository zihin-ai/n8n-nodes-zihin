import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFiles } from './check-publication.mjs';

test('publication policy rejects excess files, maps, non-English text and missing entry points', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  const write = (name, value) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), value); };
  try {
    write('package.json', JSON.stringify({ main: 'index.js' })); write('index.js', 'export const value = 1;'); write('LICENSE', 'MIT');
    const files = ['package.json', 'index.js', 'LICENSE'].map(path => ({ path }));
    const policy = { allow: ['package.json', 'index.js', 'LICENSE'], required: ['package.json', 'LICENSE'] };
    assert.deepEqual(validateFiles(root, files, policy), []);
    write('notes.md', 'Internal notes');
    assert.match(validateFiles(root, [...files, { path: 'notes.md' }], policy).join('\n'), /Unexpected file/);
    write('index.js', '//# sourceMappingURL=data:application/json;base64,e30=');
    assert.match(validateFiles(root, files, policy).join('\n'), /Source map/);
    write('index.js', 'voc\u00ea');
    assert.match(validateFiles(root, files, policy).join('\n'), /Non-English/);
    write('index.js', 'export const value = 1;');
    assert.match(validateFiles(root, files.filter(x => x.path !== 'index.js'), policy).join('\n'), /Missing entry point/);
    assert.match(validateFiles(root, [...files, { path: '../outside' }], policy).join('\n'), /Unsafe/);
    assert.match(validateFiles(root, [...files, files[0]], policy).join('\n'), /Duplicate/);
    symlinkSync(os.tmpdir(), path.join(root, 'external'));
    assert.match(validateFiles(root, [...files, { path: 'external' }], policy).join('\n'), /outside package/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
