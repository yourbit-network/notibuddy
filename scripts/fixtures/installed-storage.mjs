// Offline acceptance against the installed artifact, using only disposable keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function fixture({installed, temporary, env, run, inspectStorage}) {
  const root = env.NOTIBUDDY_HOME;
  assert(path.isAbsolute(root) && path.dirname(root) === temporary, 'Require a disposable store');
  const {DestinationStore} = await import(pathToFileURL(path.join(installed, 'dist/config.js')));
  const {generateReplyKeyPair, generateSenderSigningKeyPair, deriveDeviceId} =
    await import(pathToFileURL(path.join(installed, 'dist/crypto.js')));
  const encryption = await generateReplyKeyPair(), signing = await generateSenderSigningKeyPair();
  const bundle = {v:1, relay:'https://storage.fixture.invalid', token:'nb_snd_storage_fixture',
    pairSecret:Buffer.alloc(32).toString('base64url'),
    device:{id:await deriveDeviceId(encryption.publicKeyB64u, signing.publicKeyB64u),
      encPub:encryption.publicKeyB64u, sigPub:signing.publicKeyB64u, name:'Storage fixture'}};
  const store = new DestinationStore(root);
  await store.prepare('existing', bundle, 'Storage fixture');
  const recordFile = name => path.join(root, 'destinations', name + '.json');
  const original = fs.readFileSync(recordFile('existing'));
  const record = JSON.parse(original);
  const canaries = [bundle.token, record.keys.privateKeyJwk.d, record.fileKey.privateKeyJwk.d];
  const helper = path.join(temporary, 'storage-check-' + randomUUID() + '.mjs');
  fs.writeFileSync(helper, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {createHash} from 'node:crypto';
    import {DestinationStore} from ${JSON.stringify(pathToFileURL(path.join(installed, 'dist/config.js')).href)};
    globalThis.fetch = () => { throw new Error('Offline storage check attempted network access'); };
    const [name, file, expected] = process.argv.slice(2);
    await new DestinationStore().open(name);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected);
  `, {mode:0o600});
  const denyNetwork = path.join(temporary, 'storage-offline-' + randomUUID() + '.mjs');
  fs.writeFileSync(denyNetwork, "globalThis.fetch = () => { throw new Error('Offline storage check attempted network access'); };\n", {mode:0o600});
  const observations = [];
  async function permissions(phase) {
    let files = 0, directories = 0;
    function walk(file) {
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'No links in the private store');
      assert(stat.isDirectory() || stat.isFile(), 'Only regular private storage');
      if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, 'Private storage permissions');
      if (stat.isDirectory()) { directories++; for (const name of fs.readdirSync(file)) walk(path.join(file, name)); }
      else { files++; assert(!/\.(tmp|lock)$/.test(file), 'No staging or lock leftovers'); }
    }
    walk(root); // Include the root, not only descendants.
    if (process.platform === 'win32') { assert(inspectStorage, 'Windows requires a DACL probe'); await inspectStorage(phase); }
    observations.push({phase, files, directories, private:true});
  }
  async function cli(label, args) {
    const out = await run(label, process.execPath,
      ['--import', pathToFileURL(denyNetwork).href, path.join(installed,'dist/cli.js'), ...args], {env});
    assert(canaries.every(value => !out.stdout.includes(value) && !(out.stderr ?? '').includes(value)), 'CLI output must omit credentials');
    return out.stdout;
  }
  async function reopen(name) {
    await run('storage-reopen-' + name, process.execPath, [helper, name, recordFile(name), sha(fs.readFileSync(recordFile(name)))], {env});
  }
  try {
    await permissions('existing-before');
    assert.equal(JSON.parse(await cli('storage-status', ['status','--to','existing'])).connectionId, record.connectionId);
    assert(fs.readFileSync(recordFile('existing')).equals(original), 'Reading must preserve record bytes');
    await cli('storage-rename', ['devices','rename','existing','renamed']);
    assert(!fs.existsSync(recordFile('existing')));
    assert(fs.readFileSync(recordFile('renamed')).equals(original), 'Rename must preserve all identities and bytes');
    await reopen('renamed');
    await permissions('existing-after');

    const legacy = [['config.json',record.config], ['sender.json',record.keys]].map(([name,value]) => {
      const bytes = Buffer.from(JSON.stringify(value) + '\n'), file = path.join(root,name);
      fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'}); return {file,bytes};
    });
    const originalsUnchanged = () => {
      assert(fs.readFileSync(recordFile('renamed')).equals(original), 'Existing pairing must survive migration and failure');
      for (const {file,bytes} of legacy) assert(fs.readFileSync(file).equals(bytes), 'Legacy rollback originals must remain byte-identical');
    };
    await permissions('migration-before');
    assert.match(await cli('storage-migrate', ['devices','migrate','--to','imported']), /original files remain for rollback/);
    const importedBytes = fs.readFileSync(recordFile('imported')), imported = store.read('imported');
    assert(JSON.stringify(imported.config) === JSON.stringify(record.config), 'Migration must retain configuration');
    assert(JSON.stringify(imported.keys) === JSON.stringify(record.keys), 'Migration must retain signing keys');
    assert.notEqual(imported.connectionId,record.connectionId);
    assert.equal(imported.fileKey,undefined, 'Legacy format has no file-receiving key');
    await reopen('imported');
    await assert.rejects(store.migrate('imported'), {code:'EEXIST'});
    assert(fs.readFileSync(recordFile('imported')).equals(importedBytes), 'Duplicate import must preserve the imported identity');
    originalsUnchanged();
    await permissions('migration-after');

    for (const code of ['ENOSPC','EIO']) {
      const open = fs.openSync, write = fs.writeFileSync;
      let targetFD, injected = false;
      fs.openSync = function(file, ...args) {
        const fd = open.call(fs,file,...args);
        if (typeof file === 'string' && file.startsWith(recordFile('retry') + '.') && file.endsWith('.tmp')) targetFD = fd;
        return fd;
      };
      fs.writeFileSync = function(file, data, ...args) {
        if (file === targetFD) {
          injected = true; write.call(fs,file,String(data).slice(0,32));
          throw Object.assign(new Error('Synthetic partial write'),{code});
        }
        return write.call(fs,file,data,...args);
      };
      try { await assert.rejects(store.migrate('retry'), {code}); }
      finally { fs.openSync = open; fs.writeFileSync = write; }
      assert(injected, 'Must inject after a real partial write');
      assert(!fs.existsSync(recordFile('retry')));
      originalsUnchanged();
      await permissions('partial-' + code.toLowerCase());
    }
    await cli('storage-retry', ['devices','migrate','--to','retry']);
    await reopen('retry');
    assert(JSON.stringify(store.read('retry').keys) === JSON.stringify(record.keys), 'Retry must retain signing keys');
    originalsUnchanged();
    await permissions('retry-after');
    return {existingIdentityAndBytesPreserved:true, legacyOriginalsAndKeysPreserved:true,
      duplicateImportPreserved:true, partialWritesCleaned:['ENOSPC','EIO'], retrySucceeded:true,
      cliCredentialCanariesAbsent:true, observations,
      limits:['Normal private store only; externally widened permissions, custom/shared directories and power loss are not covered.']};
  } finally { fs.rmSync(helper,{force:true}); fs.rmSync(denyNetwork,{force:true}); }
}
