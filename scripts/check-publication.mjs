#!/usr/bin/env node
// Read-only, unauthenticated registry checks; safe to retry after npm accepts a publish.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function verifyPublication(manifest, expectedIntegrity, request = fetch) {
    const base = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`;
    async function get(url) {
        const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Registry returned HTTP ${response.status} for ${url}`);
        return response;
    }
    const [exact, latest] = await Promise.all([manifest.version, 'latest'].map(async version =>
        (await get(`${base}/${version}`)).json()));
    for (const record of [exact, latest]) {
        if (record.stub || record.name !== manifest.name || record.version !== manifest.version ||
            !record.dist?.integrity || !Object.entries(manifest.bin).every(([name, entry]) =>
                record.bin?.[name]?.replace(/^\.\//, '') === entry.replace(/^\.\//, ''))) {
            throw new Error('The exact release and latest tag must both serve the real CLI package, not a placeholder.');
        }
    }
    if (latest.dist.integrity !== exact.dist.integrity ||
        (expectedIntegrity && exact.dist.integrity !== expectedIntegrity)) {
        throw new Error('Public package integrity does not match the release candidate.');
    }
    const tarball = new URL(exact.dist.tarball);
    if (tarball.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected public tarball origin.');
    const bytes = Buffer.from(await (await get(tarball.href)).arrayBuffer());
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== exact.dist.integrity) throw new Error('Downloaded tarball failed its integrity check.');
    return `${manifest.name}@${manifest.version} is public, latest, and its tarball integrity is verified.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const packed = JSON.parse(readFileSync(new URL('../.build/release/pack.json', import.meta.url), 'utf8'))[0];
    if (packed.name !== manifest.name || packed.version !== manifest.version || !packed.integrity) {
        throw new Error('Pack metadata does not match the current release candidate.');
    }
    // npm may accept a publish before registry propagation finishes. Retry reads only.
    const attempts = process.argv.includes('--wait') ? 20 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            console.log(await verifyPublication(manifest, packed.integrity));
            break;
        } catch (error) {
            if (attempt === attempts) throw error;
            console.log(`Waiting for the public registry (${attempt}/${attempts}): ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 15_000));
        }
    }
}
