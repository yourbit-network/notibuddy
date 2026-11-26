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
import {
  SCREEN_CATALOG_COMPACT_CHEATSHEET,
  SCREEN_SEMANTIC_SLOTS,
  collectScreenAuthoringFixes,
  describeAllScreenTemplates,
  describeScreenTemplate,
  renderScreenBuilderMarkdown,
  renderScreenCatalogMarkdown,
  renderScreenTemplateMarkdown,
  renderScreenTextPreview,
  resolveCatalogSlotsToWire,
} from '../src/screen-describe.js';
import { validateScreenRequestBindings } from '../src/screen-record.js';
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

  // Public screen descriptions & generated examples validate cleanly with zero verifier/TA internals.
  const allDescriptions = describeAllScreenTemplates();
  assert.equal(allDescriptions.length, 8);
  const forbiddenUiMarkers = ['ta-catalog', 'ta-attest', 'nb-screen-ta-v1', 'recordB64u', '"kid":', '"sig":'];
  for (const desc of allDescriptions) {
    const entry = getScreenCatalogBySlug(desc.templateId)!;
    const single = describeScreenTemplate(entry.templateId)!;
    assert.deepEqual(single, desc);
    assert.ok(desc.slots.length > 0);
    assert.ok(SCREEN_SEMANTIC_SLOTS[desc.templateId]);
    const resolvedExample = resolveCatalogSlotsToWire(desc.templateId, desc.example.slots);
    assert.deepEqual(resolvedExample.errors, []);
    const counts = validateScreenRequestBindings(
      entry.skeleton,
      {
        labels: resolvedExample.labels,
        data: resolvedExample.data,
      },
      desc.templateId
    );
    assert.ok(counts);
    const preview = renderScreenTextPreview(
      entry.skeleton,
      resolvedExample.labels,
      resolvedExample.data,
      `Preview: ${desc.templateId}`
    );
    assert.ok(preview.includes('iPhone Screen Preview'));
    const md = renderScreenTemplateMarkdown(desc.templateId)!;
    assert.ok(md.includes(desc.templateId));
    assert.ok(SCREEN_CATALOG_COMPACT_CHEATSHEET.includes(desc.templateId));
    const serialized = JSON.stringify(desc) + '\n' + md;
    for (const marker of forbiddenUiMarkers) {
      assert.ok(!serialized.includes(marker), `${desc.templateId} UI description must not expose ${marker}`);
    }
  }
  const fullCatalogMd = renderScreenCatalogMarkdown();
  const builderMd = renderScreenBuilderMarkdown();
  assert.ok(builderMd.includes('Bespoke Native Screen Builder'));
  assert.ok(builderMd.includes('1 to 3 buttons'));
  assert.ok(!builderMd.includes('1 to 16'));
  assert.ok(builderMd.includes('draft_id'));
  assert.ok(builderMd.includes('YYYY-MM-DDTHH:MM:SSZ'));
  assert.ok(builderMd.includes('| Limit | Cap |'));

  // Preview includes actual diff excerpt lines for diffViewer templates
  const dbEntry = getScreenCatalogBySlug('db_migration_approval')!;
  const dbDesc = describeScreenTemplate('db_migration_approval')!;
  const dbResolved = resolveCatalogSlotsToWire('db_migration_approval', dbDesc.example.slots);
  const dbPreview = renderScreenTextPreview(dbEntry.skeleton, dbResolved.labels, dbResolved.data, 'DB Migration');
  assert.ok(dbPreview.includes('+ ') || dbPreview.includes('CREATE'), 'diffViewer preview should include diff excerpt lines');

  // Authoring pre-flight validator catches 4 actions
  const tooManyActionsFixes = collectScreenAuthoringFixes(
    {
      ...dbEntry.skeleton,
      actions: [
        dbEntry.skeleton.actions[0]!,
        dbEntry.skeleton.actions[1]!,
        { id: 'a2', label: { slot: 's9', maxGraphemes: 32, maxBytes: 128 }, role: 'secondary', requireBio: false },
        { id: 'a3', label: { slot: 's10', maxGraphemes: 32, maxBytes: 128 }, role: 'decline', requireBio: false },
      ],
    },
    dbResolved.labels,
    dbResolved.data
  );
  assert.ok(tooManyActionsFixes.some((f) => f.code === 'INVALID_ACTION_COUNT'));
  for (const slug of EXPECTED_SLUGS) {
    assert.ok(fullCatalogMd.includes(slug));
  }
  for (const marker of forbiddenUiMarkers) {
    assert.ok(!fullCatalogMd.includes(marker), `Catalog markdown must not expose ${marker}`);
    assert.ok(!builderMd.includes(marker), `Builder markdown must not expose ${marker}`);
    assert.ok(!SCREEN_CATALOG_COMPACT_CHEATSHEET.includes(marker), `Cheat sheet must not expose ${marker}`);
  }

  console.log('screen-catalog.test.ts: all 8 certified catalog templates and ta-attest-v2 verified');
}

await main();
