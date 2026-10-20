import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspectProtocol,observeTransport} from '../fixtures/installed-launchers.mjs';

const schema={parse(value){assert.equal(value.jsonrpc,'2.0');assert('id' in value || 'method' in value);}};
const frame=JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\n';
test('protocol validator rejects banners, invalid lines and unterminated tails',()=>{
  assert.equal(inspectProtocol(frame+frame,schema,[]),2);
  for(const text of ['',frame.trim(),frame+'banner',frame+'banner\n','banner\n'+frame,frame+'{}\n'])
    assert.throws(()=>inspectProtocol(text,schema,[]));
});
test('protocol validator detects a synthetic credential inside valid JSON',()=>{
  const text=JSON.stringify({jsonrpc:'2.0',id:1,result:{accidental:'private-canary'}})+'\n';
  assert.throws(()=>inspectProtocol(text,schema,['private-canary']));
  assert.equal(inspectProtocol(frame,schema,['private-canary']),1);
});
test('raw capture preserves parser bytes and rejects malformed UTF-8 or changed SDK shape',()=>{
  const forwarded=[],transport={_readBuffer:{append:chunk=>forwarded.push(chunk)}};
  const raw=observeTransport(transport),bytes=Buffer.from(frame);
  transport._readBuffer.append(bytes);assert.equal(raw(),frame);assert.equal(forwarded[0],bytes);
  transport._readBuffer.append(Buffer.from([0xff]));assert.throws(()=>raw());
  assert.throws(()=>observeTransport({}));
});
