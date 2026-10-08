import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function validateContents(packed, sources, bytes) {
  const expected = ['LICENSE', 'PROTOCOL.md', 'README.md', 'package.json'];
  for (const source of sources) {
    assert.match(source, /^src\/(?:[\w-]+\/)*[\w-]+\.ts$/);
    const stem = source.replace(/^src\//, 'dist/').replace(/\.ts$/, '');
    for (const extension of ['.js', '.js.map', '.d.ts', '.d.ts.map']) expected.push(stem + extension);
  }
  assert.ok(sources.length > 0, 'No tracked source files found.');
  assert.deepEqual(packed.files.map(file => file.path).sort(), expected.sort(),
    'Package must contain only the declared docs and output from tracked source files.');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrity, packed.integrity, 'Archive differs from npm pack metadata.');
  return expected;
}
