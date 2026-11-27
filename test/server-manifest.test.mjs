import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));

test('server.json stays within Official MCP Registry field bounds and matches package.json', () => {
  assert.equal(typeof server.name, 'string');
  assert.ok(server.name.length >= 3 && server.name.length <= 200,
    `server.json name must be 3..200 chars (got ${server.name.length})`);
  assert.equal(server.name, pkg.mcpName);

  assert.equal(typeof server.title, 'string');
  assert.ok(server.title.length >= 1 && server.title.length <= 100,
    `server.json title must be 1..100 chars (got ${server.title.length})`);

  // Official MCP Registry rejects descriptions longer than 100 characters with HTTP 422.
  assert.equal(typeof server.description, 'string');
  assert.ok(server.description.length >= 1 && server.description.length <= 100,
    `server.json description must be 1..100 chars (got ${server.description.length})`);

  assert.equal(server.version, pkg.version);
  assert.ok(server.version.length >= 1 && server.version.length <= 255);
  assert.ok(Array.isArray(server.packages) && server.packages.length > 0, 'server.json must declare at least one package');

  const npmPkg = server.packages[0];
  assert.equal(npmPkg.registryType, 'npm');
  assert.equal(npmPkg.identifier, pkg.name);
  assert.equal(npmPkg.version, pkg.version);

  assert.ok(Array.isArray(server.remotes) && server.remotes.length > 0, 'server.json must declare a remote streamable-http endpoint');
  assert.equal(server.remotes[0].type, 'streamable-http');
  assert.equal(server.remotes[0].url, 'https://mcp.notibuddy.app/mcp');

  if (server.websiteUrl) {
    assert.equal(new URL(server.websiteUrl).protocol, 'https:');
  }
  if (server.repository?.url) {
    assert.equal(new URL(server.repository.url).protocol, 'https:');
  }
  if (Array.isArray(server.icons)) {
    for (const icon of server.icons) {
      assert.equal(new URL(icon.src).protocol, 'https:');
      assert.ok(icon.src.length <= 255, `icon.src must be <= 255 chars (got ${icon.src.length})`);
    }
  }
});
