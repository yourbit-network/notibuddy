import assert from 'node:assert/strict';
import { ecdsaVerify, fromB64u, isValidP256PublicKey } from '../src/crypto.js';
import {
  SCREEN_CATALOG,
  SCREEN_CATALOG_BY_SLUG,
  SCREEN_CATALOG_BY_TEMPLATE_ID,
  SCREEN_CATALOG_SLUGS,
  SCREEN_TA_PUBLIC_KEYS,
  SCREEN_TA_SIGNING_DOMAIN,
  buildScreenTaSigningInput,
  getScreenCatalogBySlug,
  getScreenCatalogByTemplateId,
  getScreenTaPublicKey,
} from '../src/screen-catalog.js';
import { canonJson, type ScreenCanonValue } from '../src/screen-canon.js';
import { computeTemplateId, validateScreenSkeleton } from '../src/screen-wire.js';

const EXPECTED_SLUGS = [
  'db_migration_approval',
  'incident_triage',
  'code_review_form',
  'kpi_status_card',
  'action_checklist',
  'parameter_tuning_form',
  'deployment_gate',
  'multi_choice_audit',
] as const;

async function main(): Promise<void> {
  assert.equal(SCREEN_TA_SIGNING_DOMAIN, 'nb-screen-ta-v1');
  assert.deepEqual([...SCREEN_CATALOG_SLUGS], [...EXPECTED_SLUGS]);
  assert.equal(SCREEN_CATALOG.length, 8);

  const keys = Object.values(SCREEN_TA_PUBLIC_KEYS);
  const catalogKeys = keys.filter((k) => k.purpose === 'catalog' && k.status === 'active');
  const attestKeys = keys.filter((k) => k.purpose === 'attestation' && k.status === 'active');
  assert.ok(catalogKeys.length >= 1, 'Expected at least one active catalog TA public key');
  assert.ok(attestKeys.length >= 2, 'Expected ta-attest-v1 and pre-provisioned ta-attest-v2 keys');

  const catalogV1 = getScreenTaPublicKey('ta-catalog-v1');
  const attestV1 = getScreenTaPublicKey('ta-attest-v1');
  const attestV2 = getScreenTaPublicKey('ta-attest-v2');
  assert.ok(catalogV1 && catalogV1.purpose === 'catalog' && catalogV1.status === 'active');
  assert.ok(attestV1 && attestV1.purpose === 'attestation' && attestV1.status === 'active');
  assert.ok(attestV2 && attestV2.purpose === 'attestation' && attestV2.status === 'active');
  assert.equal(getScreenTaPublicKey('ta-attest-v3'), undefined);
  assert.equal(getScreenTaPublicKey('ta-unknown-v9'), undefined);

  const seenPubs = new Set<string>();
  for (const key of keys) {
    assert.equal(key.algorithm, 'ES256');
    assert.equal(isValidP256PublicKey(key.publicKeyB64u), true, `Invalid P-256 key ${key.kid}`);
    assert.ok(!seenPubs.has(key.publicKeyB64u), `Duplicate TA public key for ${key.kid}`);
    seenPubs.add(key.publicKeyB64u);
  }

  const seenIds = new Set<string>();
  for (const entry of SCREEN_CATALOG) {
    const validated = validateScreenSkeleton(entry.skeleton);
    const computedId = await computeTemplateId(validated);
    assert.equal(entry.templateId, computedId, `${entry.slug} templateId mismatch`);
    assert.equal(entry.record.v, 1);
    assert.equal(entry.record.kid, entry.kid);
    assert.equal(entry.record.templateId, entry.templateId);
    assert.equal(entry.record.sig, entry.sig);
    assert.deepEqual(entry.record.skeleton, entry.skeleton);
    assert.ok(!seenIds.has(entry.templateId), `Duplicate templateId ${entry.templateId}`);
    seenIds.add(entry.templateId);

    const decodedRecord = JSON.parse(Buffer.from(fromB64u(entry.recordB64u)).toString('utf8'));
    assert.equal(
      canonJson(decodedRecord as ScreenCanonValue),
      canonJson(entry.record as unknown as ScreenCanonValue),
      `${entry.slug} recordB64u must decode to exact canonical signed record`
    );

    const pub = getScreenTaPublicKey(entry.kid);
    assert.ok(pub, `Missing pinned TA key for ${entry.kid}`);
    assert.equal(pub, SCREEN_TA_PUBLIC_KEYS[entry.kid]);
    assert.equal(pub.purpose, 'catalog');

    const signingInput = buildScreenTaSigningInput(entry.kid, entry.templateId);
    const ok = await ecdsaVerify(pub.publicKeyB64u, signingInput, entry.sig);
    assert.equal(ok, true, `${entry.slug} ECDSA P-256 signature verification failed`);

    // Wrong key must reject.
    const wrongKeyOk = await ecdsaVerify(attestKeys[0]!.publicKeyB64u, signingInput, entry.sig);
    assert.equal(wrongKeyOk, false, `${entry.slug} signature must not verify under attestation key`);

    // Tampered kid binding must reject.
    const tamperedInput = buildScreenTaSigningInput(attestKeys[0]!.kid, entry.templateId);
    const tamperedOk = await ecdsaVerify(pub.publicKeyB64u, tamperedInput, entry.sig);
    assert.equal(tamperedOk, false, `${entry.slug} signature must bind kid`);

    // Lookup helpers match.
    assert.equal(getScreenCatalogBySlug(entry.slug), entry);
    assert.equal(SCREEN_CATALOG_BY_SLUG[entry.slug], entry);
    assert.equal(getScreenCatalogByTemplateId(entry.templateId), entry);
    assert.equal(SCREEN_CATALOG_BY_TEMPLATE_ID[entry.templateId], entry);
  }

  // Pre-provisioned `ta-attest-v2` public signed record verifies against pinned `ta-attest-v2` key
  // and fails closed under other keys or tampered/unknown kids (zero private keys in repo).
  const attestV2RecordJson =
    '{"kid":"ta-attest-v2","sig":"WP5g9teZKHlK8WU_2Nv_HkEXYYdlOw6YHomxMWFCmwkN-YZdL8GM0tkU8dtPSQh2s4znfdCj5hFaNQ5h3swRRA","skeleton":{"actions":[{"id":"a0","label":{"maxBytes":128,"maxGraphemes":32,"slot":"s2"},"requireBio":false,"role":"primary"}],"root":{"children":[{"kind":"text","style":"body","text":{"maxBytes":512,"maxGraphemes":128,"slot":"s1"}}],"header":{"maxBytes":256,"maxGraphemes":64,"slot":"s0"},"kind":"card"},"v":1},"templateId":"tpl_77bc1d9d1f9b3511d98ed6e80bb2abef41cd8ac700484783ccb2a074c315b264","v":1}';
  const attestV2Record = JSON.parse(attestV2RecordJson) as {
    v: 1;
    kid: string;
    templateId: `tpl_${string}`;
    skeleton: unknown;
    sig: string;
  };
  const attestV2Skeleton = validateScreenSkeleton(attestV2Record.skeleton);
  assert.equal(await computeTemplateId(attestV2Skeleton), attestV2Record.templateId);
  const attestV2Input = buildScreenTaSigningInput(attestV2Record.kid, attestV2Record.templateId);
  assert.equal(
    await ecdsaVerify(attestV2.publicKeyB64u, attestV2Input, attestV2Record.sig),
    true,
    'Record signed by pre-provisioned ta-attest-v2 must verify'
  );
  assert.equal(
    await ecdsaVerify(attestV1.publicKeyB64u, attestV2Input, attestV2Record.sig),
    false,
    'ta-attest-v2 record must not verify under ta-attest-v1'
  );
  assert.equal(
    await ecdsaVerify(catalogV1.publicKeyB64u, attestV2Input, attestV2Record.sig),
    false,
    'ta-attest-v2 record must not verify under ta-catalog-v1'
  );
  assert.equal(
    await ecdsaVerify(
      attestV2.publicKeyB64u,
      buildScreenTaSigningInput('ta-attest-v1', attestV2Record.templateId),
      attestV2Record.sig
    ),
    false,
    'ta-attest-v2 signature must bind kid'
  );

  // Prototype-pollution safe lookups return undefined.
  assert.equal(getScreenCatalogBySlug('__proto__'), undefined);
  assert.equal(getScreenCatalogBySlug('toString'), undefined);
  assert.equal(getScreenCatalogByTemplateId('constructor'), undefined);
  assert.equal(getScreenTaPublicKey('__proto__'), undefined);
  assert.equal(getScreenTaPublicKey('constructor'), undefined);
  assert.equal(getScreenTaPublicKey('toString'), undefined);

  console.log('screen-catalog.test.ts: all 8 certified catalog templates and ta-attest-v2 verified');
}

await main();
