import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {releaseExpectation, isolatedEnvironment, npmCLI, verifyInstalledLock, main} from '../check-installed-client.mjs';
const release = JSON.parse(fs.readFileSync(new URL('../../test-vectors/published-0.2.6.json', import.meta.url)));
const expected = releaseExpectation(release);
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'installed client safeguards ')); }

test('release expectation rejects tags, incomplete integrity and wrong archive fields', () => {
  assert.equal(expected.version, '0.2.6');
  assert.equal(expected.tarball, 'https://registry.npmjs.org/notibuddy/-/notibuddy-0.2.6.tgz');
  for (const version of ['latest','^0.2.6','0.2.6/../other','0.2.6-beta','00.2.6'])
    assert.throws(() => releaseExpectation({...release, publicRelease:{version}}));
  for (const patch of [{integrity:'sha512-short'}, {sha256:'x'.repeat(64)}, {files:0}, {files:1.5}])
    assert.throws(() => releaseExpectation({...release, archive:{...release.archive,...patch}}));
});

test('Windows environment keeps required system root without inheriting profile or credentials', () => {
  const env = isolatedEnvironment({platform:'win32',node:'C:\\Node With Spaces\\node.exe',source:{SystemRoot:'C:\\Windows',
    HOME:'private-home',USERPROFILE:'private-profile',APPDATA:'private-appdata',NPM_TOKEN:'secret',NODE_AUTH_TOKEN:'secret',
    NODE_OPTIONS:'--import private-code',HTTPS_PROXY:'private-proxy',CODEX_HOME:'private-codex',PATH:'private-bin'},
    temporary:'D:\\Temp Lane',cache:'D:\\Temp Lane\\cache',profile:'D:\\Temp Lane\\profile',user:'D:\\Temp Lane\\user.npmrc',global:'D:\\Temp Lane\\global.npmrc'});
  assert.equal(env.SystemRoot,'C:\\Windows');
  assert.equal(env.PATH,'C:\\Node With Spaces;C:\\Windows\\System32');
  assert.equal(env.NOTIBUDDY_HOME,'D:\\Temp Lane\\profile');
  assert.equal(env.USERPROFILE,'D:\\Temp Lane');
  assert.equal(env.HOMEDRIVE,'D:');
  assert.equal(env.HOMEPATH,'\\Temp Lane');
  assert.equal(env.APPDATA,'D:\\Temp Lane\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA,'D:\\Temp Lane\\AppData\\Local');
  assert.equal(env.USERNAME,'notibuddy-fixture');
  assert.equal(env.USERDOMAIN,'notibuddy-fixture');
  assert.equal(env.LOGONSERVER,'');
  for (const key of ['HOME','NPM_TOKEN','NODE_AUTH_TOKEN','NODE_OPTIONS','HTTPS_PROXY','CODEX_HOME']) assert.equal(env[key],undefined);
  assert(!JSON.stringify(env).includes('private-'));
  assert.throws(() => isolatedEnvironment({platform:'win32',source:{SystemRoot:'relative'}}));
});

test('child processes cannot restore the parent profile through SDK or Windows defaults', () => {
  const root=temp();
  try {
    const env=isolatedEnvironment({temporary:root,cache:path.join(root,'cache'),profile:path.join(root,'profile'),user:path.join(root,'user'),global:path.join(root,'global')});
    const actual=JSON.parse(execFileSync(process.execPath,['-e',"console.log(JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE,notibuddy:process.env.NOTIBUDDY_HOME,auth:process.env.NODE_AUTH_TOKEN,options:process.env.NODE_OPTIONS,homeDrive:process.env.HOMEDRIVE,homePath:process.env.HOMEPATH,appData:process.env.APPDATA,localAppData:process.env.LOCALAPPDATA}))"],
      {env:{HOME:'synthetic-sdk-default',USERPROFILE:'synthetic-sdk-default',...env},encoding:'utf8'}));
    const expectedChild={notibuddy:path.join(root,'profile')};
    if(process.platform==='win32') Object.assign(expectedChild,{profile:root,homeDrive:path.parse(root).root.replace(/\\$/,''),homePath:root.slice(2),appData:path.join(root,'AppData','Roaming'),localAppData:path.join(root,'AppData','Local')});
    assert.deepEqual(actual,expectedChild);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('npm CLI discovery validates the actual JavaScript entry and npm package identity', () => {
  const root=temp(),npm=path.join(root,'Node With Spaces','node_modules','npm');
  try {
    fs.mkdirSync(path.join(npm,'bin'),{recursive:true});fs.writeFileSync(path.join(npm,'bin','npm-cli.js'),'// synthetic entry');
    fs.writeFileSync(path.join(npm,'package.json'),JSON.stringify({name:'npm'}));
    const expectedCLI=fs.realpathSync(path.join(npm,'bin','npm-cli.js'));
    assert.equal(npmCLI(undefined,path.join(root,'Node With Spaces','node.exe')),expectedCLI);
    assert.equal(npmCLI(expectedCLI),expectedCLI);
    fs.writeFileSync(path.join(npm,'package.json'),JSON.stringify({name:'other'}));assert.throws(()=>npmCLI(expectedCLI));
    assert.throws(()=>npmCLI(path.join(root,'missing.js')));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('installed package binding rejects wrong keys, version, URL, integrity and linked substitution', () => {
  const root=temp();
  try {
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'notibuddy',version:'0.2.6'}));
    const entry={version:expected.version,resolved:expected.tarball,integrity:expected.integrity};
    const good={packages:{'node_modules/notibuddy':entry}};
    verifyInstalledLock(good,root,expected);
    assert.throws(()=>verifyInstalledLock({packages:{'node_modules/other':entry}},root,expected));
    for(const patch of [{version:'0.2.5'},{resolved:'https://other.invalid/package.tgz'},{integrity:'sha512-other'},{link:true}])
      assert.throws(()=>verifyInstalledLock({packages:{'node_modules/notibuddy':{...entry,...patch}}},root,expected));
    for(const resolved of ['https://other.invalid/dep.tgz','https://user:pass@registry.npmjs.org/dep.tgz','https://registry.npmjs.org/dep.tgz?token=x'])
      assert.throws(()=>verifyInstalledLock({packages:{...good.packages,'node_modules/dep':{resolved}}},root,expected));
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'notibuddy',version:'0.2.5'}));
    assert.throws(()=>verifyInstalledLock(good,root,expected));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('a mismatched platform cannot install or silently claim the requested OS', async () => {
  const root=temp(),originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Network must not run');};
  try {
    const code=await main(['--release','missing-release-must-not-be-read','--output',root,'--expected-platform',process.platform==='win32'?'darwin':'win32']);
    assert.equal(code,1);assert.equal(calls,0);
    const receipt=JSON.parse(fs.readFileSync(path.join(root,'receipt.json')));
    assert.equal(receipt.completed,false);assert.equal(receipt.failure.stage,'preflight');assert.equal(receipt.noTemporaryLaneCreated,true);
    assert.deepEqual(receipt.commands,[]);
  } finally {globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
});
