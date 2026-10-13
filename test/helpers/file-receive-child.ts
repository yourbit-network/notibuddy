// A disposable crash fixture. Only this child terminates itself; no host process is targeted.
import fs from 'node:fs';
import path from 'node:path';
import { DestinationStore } from '../../src/config.js';
import { FileInbox } from '../../src/files.js';

const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {record,signingKey}=await new DestinationStore(fixture.root).open('phone');
const inbox=new FileInbox(record,signingKey,fixture.root),target=path.join(inbox.directory,fixture.manifest.id);
const crash=()=>{fs.writeFileSync(path.join(fixture.root,'crash-reached'),fixture.point,{mode:0o600});process.kill(process.pid,'SIGKILL');};
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{
  if(String(to)===target && fixture.point==='before-publish')crash();
  if(String(to)===path.join(target,'receipt.json') && fixture.point==='before-receipt-publish')crash();
  rename(from,to);
  if(String(to)===target && fixture.point==='after-publish')crash();
  if(String(to)===path.join(target,'receipt.json') && fixture.point==='after-receipt-publish')crash();
};
globalThis.fetch=async(input)=>{
  if(String(input).endsWith('/ack')) {
    fs.writeFileSync(path.join(fixture.root,'ack-recorded'),'accepted',{mode:0o600});
    if(fixture.point==='after-ack')crash();
    return Response.json({status:'delivered'});
  }
  return new Response(Buffer.from(fixture.ciphertext,'base64url'),{headers:{'X-File-Manifest':Buffer.from(JSON.stringify(fixture.manifest)).toString('base64url')}});
};
await inbox.receive(fixture.manifest.id);
throw Error('The crash fixture did not reach its expected interruption point');
