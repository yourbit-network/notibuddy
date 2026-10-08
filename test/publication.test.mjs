import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyPublication } from '../scripts/check-publication.mjs';

const bytes = Buffer.from('downloaded package fixture');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const manifest = { name: 'notibuddy', version: '0.1.0', bin: { notibuddy: './dist/cli.js' } };
const record = { ...manifest, bin: { notibuddy: 'dist/cli.js' }, dist: { integrity, tarball: 'https://registry.npmjs.org/notibuddy/-/notibuddy-0.1.0.tgz' } };
function registry({ exact = record, latest = record, tarball = bytes, downloadStatus = 200 } = {}) {
    return async url => {
        if (url.endsWith('.tgz')) return new Response(tarball, { status: downloadStatus });
        const value = url.endsWith('/latest') ? latest : exact;
        return new Response(JSON.stringify(value), { status: value === null ? 404 : 200 });
    };
}

test('accepts the real latest release only after downloading and verifying its tarball', async () => {
    assert.match(await verifyPublication(manifest, integrity, registry()), /is public, latest/);
});
test('rejects a publish that is accepted but still unavailable', async () => {
    await assert.rejects(verifyPublication(manifest, integrity, registry({ exact: null })), /HTTP 404/);
});
test('rejects the staged placeholder and stale latest tag', async () => {
    for (const latest of [{ ...record, stub: true }, { ...record, version: '0.0.0-stage' }, { ...record, bin: {} }]) {
        await assert.rejects(verifyPublication(manifest, integrity, registry({ latest })), /real CLI package/);
    }
});
test('rejects public metadata for a different release candidate', async () => {
    await assert.rejects(verifyPublication(manifest, 'sha512-other', registry()), /release candidate/);
});
test('rejects unavailable or corrupted public tarballs', async () => {
    await assert.rejects(verifyPublication(manifest, integrity, registry({ downloadStatus: 404 })), /HTTP 404/);
    await assert.rejects(verifyPublication(manifest, integrity, registry({ tarball: 'corrupted' })), /integrity check/);
});
