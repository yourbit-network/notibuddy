import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  SCREEN_MAX_INT53,
  SCREEN_MIN_INT53,
  SCREEN_PUBLIC_CAPS,
  SCREEN_UNAVAILABLE_ACTION,
  allChecked,
  buildScreenAnswerValues,
  buildScreenRenderedAnswer,
  buildScreenUnavailableAnswer,
  buildScreenUnavailableAnswerValues,
  canonJson,
  canonRenderInput,
  computeScreenContextDigest,
  computeScreenRenderDigest,
  computeTemplateId,
  escapeCanonString,
  evaluatePredicatesFlat,
  evaluateScreenPredicates,
  isActionOrdinal,
  isChecklistOrdinal,
  isFieldOrdinal,
  isScreenUnavailableAction,
  isSlotOrdinal,
  isValidFormShapeFlat,
  isValidTemplateId,
  projectPickerIndex,
  projectScreenForm,
  projectStepperValue,
  sortKeysBytewise,
  validateScreenAnswer,
  validateScreenAnswerValues,
  validateScreenForm,
  validateScreenRequestPlaintext,
  validateScreenSkeleton,
  verifyScreenAnswer,
  verifyScreenAnswerDigest,
} from '../src/index.js';

const fixture = JSON.parse(
  fs.readFileSync(new URL('../test-vectors/screen-wire-v1.json', import.meta.url), 'utf8')
);

test('shared plain-data vectors pass identically in TypeScript', async () => {
  assert.equal(fixture.schemaVersion, 1);

  for (const item of fixture.canonStrings) {
    assert.equal(escapeCanonString(item.input), item.expected);
  }

  for (const item of fixture.keyOrder) {
    assert.deepEqual(sortKeysBytewise(item.input), item.expected);
  }

  const skeletonsByName = new Map();
  for (const item of fixture.skeletons) {
    const validated = validateScreenSkeleton(item.skeleton);
    skeletonsByName.set(item.name, validated);
    assert.equal(canonJson(validated as unknown as Parameters<typeof canonJson>[0]), item.canonicalJson);
    const tplId = await computeTemplateId(validated);
    assert.equal(tplId, item.templateId);
    assert.equal(isValidTemplateId(tplId), true);
  }

  for (const req of fixture.requests) {
    const skeleton = skeletonsByName.get(req.skeletonName);
    assert.ok(skeleton);

    const parsedPlaintext = validateScreenRequestPlaintext(JSON.parse(req.rawPlaintextUtf8));
    assert.deepEqual(parsedPlaintext, req.plaintext);

    const ctx = await computeScreenContextDigest(
      req.requestId,
      new TextEncoder().encode(req.rawPlaintextUtf8)
    );
    assert.equal(ctx, req.contextDigest);

    const formCheck = validateScreenForm(
      skeleton,
      req.form,
      req.checklistCounts,
      req.pickerOptionCounts
    );
    assert.deepEqual(formCheck, { ok: true });

    const canonRender = canonRenderInput(req.action, req.form);
    assert.equal(canonRender, req.canonRenderInput);

    const renderDigest = await computeScreenRenderDigest(ctx, req.action, req.form);
    assert.equal(renderDigest, req.renderDigest);

    const built = await buildScreenAnswerValues(ctx, req.action, req.form);
    assert.deepEqual(built, req.answerValues);

    const verified = await verifyScreenAnswerDigest(ctx, req.action, built);
    assert.equal(verified.renderDigest, req.renderDigest);
    assert.deepEqual(verified.form, req.form);
  }

  for (const item of fixture.allCheckedCases) {
    assert.equal(allChecked(item.items), item.expected);
  }

  assert.ok(Array.isArray(fixture.answerCases.accept) && fixture.answerCases.accept.length >= 5);
  assert.ok(Array.isArray(fixture.answerCases.reject) && fixture.answerCases.reject.length >= 25);

  for (const item of fixture.answerCases.accept) {
    const parsed = validateScreenAnswer(item.answer);
    assert.deepEqual(parsed, item.answer, item.name);
    assert.deepEqual(validateScreenAnswerValues(item.answer.values), item.answer.values, item.name);
    if (item.variant === 'rendered') {
      assert.equal(isActionOrdinal(parsed.action), true, item.name);
      assert.equal('form' in parsed.values, true, item.name);
    } else {
      assert.equal(item.variant, 'unavailable', item.name);
      assert.equal(parsed.action, SCREEN_UNAVAILABLE_ACTION, item.name);
      assert.equal(isScreenUnavailableAction(parsed.action), true, item.name);
      assert.equal(isActionOrdinal(parsed.action), false, item.name);
      assert.deepEqual(parsed.values, { render: { v: 1, unavailable: true } }, item.name);
    }
  }

  for (const item of fixture.answerCases.reject) {
    assert.throws(() => validateScreenAnswer(item.answer), item.name);
  }
});

test('ordinal validators reject leading zeros and wrong prefixes', () => {
  assert.equal(isSlotOrdinal('s0'), true);
  assert.equal(isSlotOrdinal('s10'), true);
  assert.equal(isSlotOrdinal('s01'), false);
  assert.equal(isSlotOrdinal('f0'), false);

  assert.equal(isFieldOrdinal('f0'), true);
  assert.equal(isFieldOrdinal('f12'), true);
  assert.equal(isFieldOrdinal('f00'), false);

  assert.equal(isChecklistOrdinal('c0'), true);
  assert.equal(isChecklistOrdinal('c01'), false);

  assert.equal(isActionOrdinal('a0'), true);
  assert.equal(isActionOrdinal('a00'), false);

  assert.equal(isValidTemplateId(`tpl_${'a'.repeat(64)}`), true);
  assert.equal(isValidTemplateId(`tpl_${'A'.repeat(64)}`), false);
  assert.equal(isValidTemplateId(`tpl_${'a'.repeat(63)}`), false);
});

test('strict request plaintext rejects unknown keys, control/format scalars, floats, null, and bad thread links', () => {
  const base = JSON.parse(fixture.requests[0].rawPlaintextUtf8);

  assert.throws(() => validateScreenRequestPlaintext({ ...base, unexpected: true }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, type: 'activity' }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, templateId: 'tpl_short' }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, labels: { s01: 'bad key' } }));

  for (const badText of ['bidi\u202Eoverride', 'zw\u200Bspace', 'bell\u0007', 'new\nline', '\uD800']) {
    assert.throws(() => validateScreenRequestPlaintext({ ...base, title: badText }));
    assert.throws(() => validateScreenRequestPlaintext({ ...base, labels: { s0: badText } }));
  }

  assert.throws(() => validateScreenRequestPlaintext({ ...base, data: { s4: [1.5] } }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, data: { s4: null } }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, data: { s4: SCREEN_MAX_INT53 + 1 } }));
  assert.throws(() => validateScreenRequestPlaintext({ ...base, data: { s4: SCREEN_MIN_INT53 - 1 } }));
  assert.doesNotThrow(() =>
    validateScreenRequestPlaintext({ ...base, data: { s4: [SCREEN_MIN_INT53, 0, SCREEN_MAX_INT53] } })
  );

  assert.throws(() =>
    validateScreenRequestPlaintext({
      ...base,
      thread: {
        id: 'thr_1',
        step: 1,
        of: 2,
        prev: { requestId: 'req_0', renderDigest: '0'.repeat(64) },
      },
    })
  );
  assert.throws(() =>
    validateScreenRequestPlaintext({
      ...base,
      thread: { id: 'thr_1', step: 2, of: 2 },
    })
  );
});

test('total form projection, validation, predicates, and answer digest verification', async () => {
  const skeleton = validateScreenSkeleton(fixture.skeletons[0].skeleton);

  const projected = projectScreenForm(
    skeleton,
    { 'c0.0': true, 'c0.2': true, extra_ignored: 'drop' },
    { c0: 3 },
    { f2: 2 }
  );
  assert.deepEqual(projected, {
    f0: '',
    f1: false,
    f2: -1,
    f3: 2,
    c0: [true, false, true],
  });

  // Non-integral stepper must fail closed.
  assert.throws(() => projectScreenForm(skeleton, { f3: 2.5 }, { c0: 3 }, { f2: 2 }));

  const approveAction = skeleton.actions[0];
  const declineAction = skeleton.actions[1];
  assert.equal(evaluateScreenPredicates(approveAction, skeleton, projected), false);
  assert.equal(evaluateScreenPredicates(declineAction, skeleton, projected), true);
  assert.equal(evaluateScreenPredicates(approveAction, skeleton, fixture.requests[0].form), true);

  // Tampered renderDigest is rejected.
  const ctx = fixture.requests[0].contextDigest;
  const tampered = structuredClone(fixture.requests[0].answerValues);
  tampered.render.digest = '0'.repeat(64);
  await assert.rejects(() => verifyScreenAnswerDigest(ctx, 'a0', tampered));
  assert.throws(() => validateScreenAnswerValues({ ...tampered, extra: 1 }));
});

test('skeleton validator enforces strict keys, traversal ordinals, and loose public caps', () => {
  const base = structuredClone(fixture.skeletons[0].skeleton);
  base.root.children[0].header.slot = 's99';
  assert.throws(() => validateScreenSkeleton(base));

  // Exceeding depth cap (>16) fails closed.
  let nested: Record<string, unknown> = { kind: 'divider' };
  for (let i = 0; i < 18; i += 1) {
    nested = { kind: 'vstack', children: [nested] };
  }
  assert.throws(() =>
    validateScreenSkeleton({
      v: 1,
      root: nested,
      actions: [
        {
          id: 'a0',
          label: { slot: 's0', maxGraphemes: 16, maxBytes: 64 },
          role: 'primary',
          requireBio: false,
        },
      ],
    })
  );
});

test('hardening: __proto__ safety, non-plain object rejection, answer prefix/type checks, picker bounds, and helper guards', async () => {
  const base = JSON.parse(fixture.requests[0].rawPlaintextUtf8);

  // __proto__ in JSON.parse data must define an own property, never mutate prototype, and still enforce byte cap.
  const protoSmall = JSON.parse(
    JSON.stringify({ ...base, data: {} }).replace('"data":{}', '"data":{"s4":{"__proto__":{"k":1}}}')
  );
  const validatedProto = validateScreenRequestPlaintext(protoSmall);
  const s4 = validatedProto.data.s4 as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(s4, '__proto__'), true);
  assert.equal((s4 as { k?: unknown }).k, undefined);

  const protoHuge = JSON.parse(
    JSON.stringify({ ...base, data: {} }).replace(
      '"data":{}',
      `"data":{"s4":{"__proto__":{"pad":"${'X'.repeat(160_000)}"}}}`
    )
  );
  assert.throws(() => validateScreenRequestPlaintext(protoHuge));

  // Non-plain objects fail closed everywhere instead of coercing to `{}`.
  for (const nonPlain of [new Date(), new Map(), new Set(), new Uint8Array([1, 2]), /re/]) {
    assert.throws(() => canonJson(nonPlain as unknown as Parameters<typeof canonJson>[0]));
    assert.throws(() => validateScreenRequestPlaintext({ ...base, data: { s4: nonPlain } }));
    assert.equal(validateScreenForm(fixture.skeletons[0].skeleton, nonPlain).ok, false);
    assert.throws(() =>
      projectScreenForm(
        fixture.skeletons[0].skeleton,
        nonPlain as unknown as Record<string, unknown>,
        { c0: 3 },
        { f2: 2 }
      )
    );
  }

  // Answer values reject wrong prefix/type combinations and oversized payloads.
  const validRender = { v: 1, digest: '0'.repeat(64) };
  assert.throws(() => validateScreenAnswerValues({ form: { c0: 'str' }, render: validRender }));
  assert.throws(() => validateScreenAnswerValues({ form: { c0: true }, render: validRender }));
  assert.throws(() => validateScreenAnswerValues({ form: { c0: 42 }, render: validRender }));
  assert.throws(() => validateScreenAnswerValues({ form: { f0: [true] }, render: validRender }));
  assert.throws(() =>
    validateScreenAnswerValues({
      form: { f0: 'a'.repeat(SCREEN_PUBLIC_CAPS.maxSlotBytes + 1) },
      render: validRender,
    })
  );

  // Picker options slot bounds (`minItems..maxItems`) enforced in project & validate.
  const skeleton = validateScreenSkeleton(fixture.skeletons[0].skeleton);
  assert.throws(() => projectScreenForm(skeleton, {}, { c0: 3 }, { f2: 0 }));
  assert.throws(() => projectScreenForm(skeleton, {}, { c0: 3 }, { f2: 99 }));
  assert.equal(validateScreenForm(skeleton, fixture.requests[0].form, { c0: 3 }, { f2: 0 }).ok, false);
  assert.equal(validateScreenForm(skeleton, fixture.requests[0].form, { c0: 3 }, { f2: 99 }).ok, false);

  // Omitted field.maxBytes still enforces SCREEN_PUBLIC_CAPS.maxSlotBytes fallback.
  const wideSkeleton = validateScreenSkeleton(fixture.skeletons[1].skeleton);
  const oversizedText = 'x'.repeat(SCREEN_PUBLIC_CAPS.maxSlotBytes + 1);
  assert.throws(() => projectScreenForm(wideSkeleton, { f0: oversizedText }, { c0: 2 }, { f2: 2 }));
  assert.equal(
    validateScreenForm(
      wideSkeleton,
      { ...fixture.requests[1].form, f0: oversizedText },
      { c0: 2 },
      { f2: 2 }
    ).ok,
    false
  );

  // Exported flat helpers enforce int53 / boolean / parallel-length invariants.
  assert.equal(allChecked([1 as unknown as boolean]), false);
  assert.throws(() => projectStepperValue(2.5, 1, 1, 10, true));
  assert.throws(() => projectPickerIndex(1.5, 0, 3, true));
  assert.equal(
    isValidFormShapeFlat(['f0'], [2], [0], [10], ['f0'], [2], [2.5], [0]),
    false
  );
  assert.equal(
    isValidFormShapeFlat(['f0', 'f1'], [0], [0, 0], [0, 0], ['f0', 'f1'], [0, 0], [0, 0], [0, 0]),
    false
  );
  assert.equal(evaluatePredicatesFlat([0], [0], [1], [0], [1], [0], [1.5]), false);

  // contextDigest enforces maxRequestPlaintextBytes.
  await assert.rejects(() =>
    computeScreenContextDigest('req_1', new Uint8Array(SCREEN_PUBLIC_CAPS.maxRequestPlaintextBytes + 1))
  );

  // Whitespace parity: U+FEFF trims to empty; U+200B and U+0085 stay non-empty.
  const approveAction = skeleton.actions[0];
  assert.equal(
    evaluateScreenPredicates(approveAction, skeleton, { ...fixture.requests[0].form, f0: '\uFEFF' }),
    false
  );
  assert.equal(
    evaluateScreenPredicates(approveAction, skeleton, { ...fixture.requests[0].form, f0: '\u200B' }),
    true
  );
  assert.equal(
    evaluateScreenPredicates(approveAction, skeleton, { ...fixture.requests[0].form, f0: '\u0085' }),
    true
  );
});

test('screen answer two-variant union: builders, verifiers, standalone values, and boundary checks', async () => {
  const req0 = fixture.requests[0];
  const ctx = req0.contextDigest;

  assert.equal(SCREEN_UNAVAILABLE_ACTION, 'dismiss');
  assert.equal(isScreenUnavailableAction('dismiss'), true);
  assert.equal(isActionOrdinal('dismiss'), false);
  assert.equal(isScreenUnavailableAction('a0'), false);

  // Unavailable builders and verification.
  const unavailableValues = buildScreenUnavailableAnswerValues();
  assert.deepEqual(unavailableValues, { render: { v: 1, unavailable: true } });
  assert.deepEqual(validateScreenAnswerValues(unavailableValues), unavailableValues);

  const unavailableMinimal = buildScreenUnavailableAnswer();
  assert.deepEqual(unavailableMinimal, {
    action: 'dismiss',
    values: { render: { v: 1, unavailable: true } },
  });
  assert.deepEqual(validateScreenAnswer(unavailableMinimal), unavailableMinimal);
  assert.deepEqual(await verifyScreenAnswer(ctx, unavailableMinimal), {
    kind: 'unavailable',
    action: 'dismiss',
  });

  const unavailableUnauth = buildScreenUnavailableAnswer(false);
  assert.deepEqual(await verifyScreenAnswer(ctx, unavailableUnauth), {
    kind: 'unavailable',
    action: 'dismiss',
    authenticated: false,
  });

  // Rendered builders and verification.
  const renderedAnswer = await buildScreenRenderedAnswer(ctx, req0.action, req0.form, true);
  assert.deepEqual(validateScreenAnswer(renderedAnswer), renderedAnswer);
  assert.deepEqual(await verifyScreenAnswer(ctx, renderedAnswer), {
    kind: 'rendered',
    action: req0.action,
    form: req0.form,
    renderDigest: req0.renderDigest,
    authenticated: true,
  });

  // Cross-variant builder/verifier rejections.
  await assert.rejects(() => buildScreenRenderedAnswer(ctx, 'dismiss', {}));
  await assert.rejects(() => verifyScreenAnswerDigest(ctx, 'dismiss', unavailableValues));
  await assert.rejects(() => verifyScreenAnswerDigest(ctx, 'a0', unavailableValues));
  await assert.rejects(() => verifyScreenAnswer('not-hex', unavailableMinimal));

  const tamperedRendered = structuredClone(renderedAnswer);
  tamperedRendered.values.render.digest = '0'.repeat(64);
  await assert.rejects(() => verifyScreenAnswer(ctx, tamperedRendered));

  // Standalone validateScreenAnswerValues rejects every invalid values shape.
  const validDigest = '0'.repeat(64);
  assert.throws(() => validateScreenAnswerValues({ form: {}, render: { v: 1, unavailable: true } }));
  assert.throws(() => validateScreenAnswerValues({ render: { v: 1, digest: validDigest } }));
  assert.throws(() => validateScreenAnswerValues({ render: { v: 1, unavailable: false } }));
  assert.throws(() => validateScreenAnswerValues({ render: { v: 1, unavailable: true }, extra: 1 }));
  assert.throws(() =>
    validateScreenAnswerValues({ form: undefined, render: { v: 1, unavailable: true } })
  );

  // Explicit own key `text: undefined` and `__proto__` keys fail closed.
  assert.throws(() =>
    validateScreenAnswer({
      action: 'dismiss',
      text: undefined,
      values: { render: { v: 1, unavailable: true } },
    })
  );
  const withProto = JSON.parse(
    '{"action":"dismiss","values":{"render":{"v":1,"unavailable":true}},"__proto__":{}}'
  );
  assert.throws(() => validateScreenAnswer(withProto));

  // Plaintext byte cap enforced on rendered screen answers and builders.
  const hugeForm: Record<string, string> = {};
  for (let i = 0; i < 12; i += 1) {
    hugeForm[`f${i}`] = 'x'.repeat(14_000);
  }
  assert.throws(() =>
    validateScreenAnswer({
      action: 'a0',
      values: { form: hugeForm, render: { v: 1, digest: validDigest } },
    })
  );
  await assert.rejects(() => buildScreenRenderedAnswer(ctx, 'a0', hugeForm));

  // Slash-heavy near-cap answer (10 fields x 10,000 '/' ~ 100,208 bytes <= 149,984) passes parity checks.
  const slashForm: Record<string, string> = {};
  for (let i = 0; i < 10; i += 1) {
    slashForm[`f${i}`] = '/'.repeat(10_000);
  }
  const builtSlash = await buildScreenRenderedAnswer(ctx, 'a0', slashForm);
  assert.deepEqual(validateScreenAnswer(builtSlash), builtSlash);
  const verifiedSlash = await verifyScreenAnswer(ctx, builtSlash);
  assert.equal(verifiedSlash.kind, 'rendered');

  // Builders validate form keys/types/bounds, normalize -0 -> 0, and clone checklist arrays.
  await assert.rejects(() =>
    buildScreenAnswerValues(ctx, 'a0', { badKey: 'oops' })
  );
  await assert.rejects(() =>
    buildScreenAnswerValues(ctx, 'a0', { c0: 'not-bools' as unknown as boolean[] })
  );
  await assert.rejects(() =>
    buildScreenAnswerValues(ctx, 'a0', { f0: [true] as unknown as string })
  );
  await assert.rejects(() =>
    buildScreenAnswerValues(ctx, 'a0', { f0: 'a'.repeat(SCREEN_PUBLIC_CAPS.maxSlotBytes + 1) })
  );
  await assert.rejects(() =>
    buildScreenRenderedAnswer(ctx, 'a0', { badKey: 'oops' })
  );

  const mutableChecklist = [true, false];
  const builtNormalized = await buildScreenRenderedAnswer(ctx, 'a0', {
    f0: -0,
    c0: mutableChecklist,
  });
  mutableChecklist[1] = true;
  assert.equal(Object.is(builtNormalized.values.form.f0, 0), true);
  assert.deepEqual(builtNormalized.values.form.c0, [true, false]);
  assert.deepEqual(await verifyScreenAnswer(ctx, builtNormalized), {
    kind: 'rendered',
    action: 'a0',
    form: { f0: 0, c0: [true, false] },
    renderDigest: builtNormalized.values.render.digest,
  });
});
