import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateContents } from '../scripts/package-contents.mjs';

const bytes = Buffer.from('test archive');
const packed = {
  files: ['LICENSE', 'PROTOCOL.md', 'README.md', 'package.json', 'dist/cli.js', 'dist/cli.js.map', 'dist/cli.d.ts', 'dist/cli.d.ts.map'].map(path => ({ path })),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
};
test('accepts only the expected build outputs and documents', () => {
  assert.equal(validateContents(packed, ['src/cli.ts'], bytes).length, 8);
});
test('rejects extra files, including plausible but untracked build outputs', () => {
  for (const path of ['.npmrc', 'test-vectors/v1.json', 'dist/private.js', '../secret']) {
    assert.throws(() => validateContents({ ...packed, files: [...packed.files, { path }] }, ['src/cli.ts'], bytes));
  }
});
test('rejects missing build outputs and changed archive bytes', () => {
  assert.throws(() => validateContents({ ...packed, files: packed.files.slice(1) }, ['src/cli.ts'], bytes));
  assert.throws(() => validateContents(packed, ['src/cli.ts'], Buffer.from('changed')));
});
