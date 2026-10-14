#!/usr/bin/env node
import { parsePairingBundle } from './protocol.js';
import { computePairingMac } from './crypto.js';
import { DestinationStore, senderLabel } from './config.js';
import { NotiBuddyClient } from './client.js';
import { runMcpServer } from './mcp.js';
import { createDestinationRouter, parseRoutingArgs } from './routing.js';
import { resolveFileDestination } from './file-routing.js';

async function withShutdown<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const controller=new AbortController();
  const interrupt=()=>{process.exitCode=130;controller.abort(new DOMException('Interrupted','AbortError'));};
  const terminate=()=>{process.exitCode=143;controller.abort(new DOMException('Terminated','AbortError'));};
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  try{return await operation(controller.signal);}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}

function printHelp(): void {
  console.log(`NotiBuddy CLI (nb) — Encrypted requests and replies

Usage:
  nb pair <bundle> --to <name> [--label <connection-name>]
  nb files list --to <name>
  nb files receive <file_id> --to <name>
  nb files receive <file_id> --pairing <device_id>:<sender_key_id>
  nb ask "<title>" --to <name> [--sender <label>] [options]
  nb ask --resume <request-id> --to <name>
  nb activity <id> <start|update|end|poll> --to <name> [options]
  nb mcp --to <name> [--sender <label>]
  nb mcp --allow-to <name> --allow-to <name> [--sender <label>]
  nb devices list
  nb devices migrate --to <name>     Import old pairing; retain keys and replies
  nb devices rename <old> <new>      Change a local alias, keeping its identity
  nb doctor --to <name>             Verify relay, approval, and protocol compatibility
  nb status [--to <name>]
  nb unpair --to <name>              Forget locally; revoke separately on phone

All destinations live under ~/.notibuddy. Sending requires an explicit destination.
--sender is a free-form display label (default: hostname), not a new pairing.
MCP with --allow-to requires 'to' on every request; no fallback or broadcast.
File commands copied from the phone use --pairing to find the exact saved identities.

Ask options:
  --message, -m <text>       Prompt details
  --options, -o <a,b,...>    Action buttons
  --placeholder, -p <text>  Free-text reply
  --wait, -w <seconds>      Wait before returning pending (max 55)
  --requires-auth           Require phone biometrics
  --sensitive               Hide content in notification previews

Activity options:
  --title, -t <text>         Display title
  --status, -s <text>        Progress description
  --step <number> --total-steps <number>
  --timer <minutes> --sensitive
`);
}

function argumentsFor(args:string[],values:string[],booleans:string[]=[]) {
  const options:Record<string,string|boolean>={}, positional:string[]=[];
  const aliases:Record<string,string>={'-m':'--message','-o':'--options','-p':'--placeholder','-w':'--wait','-t':'--title','-s':'--status','-l':'--label'};
  for(let i=0;i<args.length;i++) {
    if(!args[i].startsWith('-')) {positional.push(args[i]);continue;}
    const [raw,inline]=args[i].split(/=(.*)/s,2),flag=aliases[raw]??raw;
    if(flag in options) throw new Error(`Duplicate option ${flag}`);
    if(booleans.includes(flag)) {if(inline!==undefined)throw new Error(`${flag} does not take a value`); options[flag]=true;continue;}
    if(!values.includes(flag)) throw new Error(`Unknown option ${flag}`);
    const value=inline??args[++i];
    if(value===undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    options[flag]=value;
  }
  return {positional,text:(flag:string)=>options[flag] as string|undefined,
    number:(flag:string)=>options[flag]===undefined?undefined:Number(options[flag]),flag:(flag:string)=>options[flag]===true};
}

async function main():Promise<void> {
  const raw=process.argv.slice(2);
  if(!raw.length || ['--help','-h','help'].includes(raw[0])) {printHelp();return;}
  const {options:routing,rest}=parseRoutingArgs(raw), command=rest.shift();
  const store=new DestinationStore();
  if(command==='mcp') {if(rest.length)throw new Error('Unknown MCP arguments');await runMcpServer(routing);return;}
  if(routing.allowTo) throw new Error('--allow-to is only supported by MCP; use --to');
  if(command==='devices') {
    const action=rest.shift();
    if(action==='list' && !rest.length) {console.log(JSON.stringify(store.list(),null,2));return;}
    if(action==='migrate' && routing.to && !rest.length) {
      await store.migrate(routing.to);
      console.log(`Imported as '${routing.to}'. Keys and pending replies are unchanged; original files remain for rollback. Update MCP to: nb mcp --to ${routing.to}`);return;
    }
    if(action==='rename' && rest.length===2) {store.rename(rest[0],rest[1]);console.log('Destination renamed; pairing and pending replies are unchanged. Update any CLI/MCP destination arguments.');return;}
    throw new Error('Use devices list, devices migrate --to <name>, or devices rename <old> <new>');
  }
  if(command==='status') {
    if(rest.length)throw new Error('Unknown status arguments');
    const destinations=store.list();
    if(routing.to) {await store.open(routing.to);console.log(JSON.stringify(destinations.find(d=>d.name===routing.to),null,2));}
    else console.log(destinations.length?JSON.stringify(destinations,null,2):'No named destinations paired. Run nb pair <bundle> --to <name>, or nb devices migrate --to <name> to import existing setup.');
    return;
  }
  if(command==='files') {
    const args=argumentsFor(rest,['--pairing']);
    const action=args.positional[0];
    if(!(action==='list' && args.positional.length===1) && !(action==='receive' && args.positional.length===2))throw new Error('Use nb files list --to <name>, or nb files receive <file_id> with --to <name> or --pairing <device_id>:<sender_key_id>.');
    const route=await resolveFileDestination({to:routing.to,pairing:args.text('--pairing')},store);
    const result=action==='list'?await route.files.list():await route.files.receive(args.positional[1]);
    console.log(JSON.stringify({to:route.name,connectionId:route.record.connectionId,result},null,2));return;
  }
  if(!routing.to) throw new Error('Choose a destination with --to <name>. Use nb devices list to see saved names.');
  if(command==='unpair') {
    if(rest.length)throw new Error('Unknown unpair arguments');
    store.forget(routing.to);console.log('Local destination credentials removed. Disconnect the connection on the phone to revoke access.');return;
  }
  if(command==='pair') {
    if(routing.sender)throw new Error('Use --label for the approved connection name; --sender labels individual requests.');
    const args=argumentsFor(rest,['--label']);
    if(args.positional.length!==1)throw new Error('Use nb pair <bundle> --to <name>');
    const bundle=await parsePairingBundle(args.positional[0]);
    const label=args.text('--label')??store.list().find(d=>d.name===routing.to)?.connectionLabel??senderLabel();
    const {record,signingKey}=await store.prepare(routing.to,bundle,label);
    const {config,keys}=record;
    const mac=await computePairingMac(bundle.pairSecret,bundle.device.id,keys.senderKeyId,keys.publicKeyB64u,label,record.fileKey!.publicKeyB64u);
    const client=new NotiBuddyClient(config,signingKey);
    const status=await withShutdown(signal=>client.registerSender({senderKeyId:keys.senderKeyId,senderPub:keys.publicKeyB64u,label,mac,fileEncPub:record.fileKey!.publicKeyB64u,fileDeviceId:config.device.id},{signal}));
    console.log(`${status==='registered'?'Pairing confirmed':'Phone approval required'}
Destination: ${routing.to}
Phone: ${config.device.name || 'iPhone'}
Connection: ${label}
Sender Key ID: ${keys.senderKeyId}

Open NotiBuddy → Connect. Compare the full Sender Key ID, then approve the connection.
A new pairing request replaces an older pending approval; approved connections stay paired.
Pending approval expires after 15 minutes.

MCP configuration:
${JSON.stringify({mcpServers:{notibuddy:{command:'npx',args:['-y','notibuddy@^0.2.0','mcp','--to',routing.to]}}})}`);
    return;
  }
  if(command==='doctor') {
    if(rest.length)throw Error('Use nb doctor --to <name>');
    const route=(await createDestinationRouter(routing,store)).resolve();
    const result=await withShutdown(signal=>route.client.doctor({signal}));
    console.log(JSON.stringify({...result,to:route.name,connectionId:route.record.connectionId,
      fileReceiving:route.record.fileKey?'enabled':'pair_again_to_enable',receiveCommand:`nb files list --to ${route.name}`},null,2));return;
  }
  if(command==='ask') {
    const args=argumentsFor(rest,['--message','--options','--placeholder','--wait','--resume'],['--requires-auth','--sensitive']);
    if(args.positional.length>1)throw new Error('Quote the request title as one argument');
    const route=(await createDestinationRouter(routing,store)).resolve();
    const result=await withShutdown(signal=>route.client.ask({title:args.positional[0],resumeId:args.text('--resume'),message:args.text('--message'),
      options:args.text('--options')?.split(',').map(s=>s.trim()),inputPlaceholder:args.text('--placeholder'),
      waitSeconds:args.number('--wait')??45,requiresAuth:args.flag('--requires-auth'),sensitive:args.flag('--sensitive')},{signal}));
    console.log(JSON.stringify({...result,to:route.name,connectionId:route.record.connectionId},null,2));return;
  }
  if(command==='activity') {
    const args=argumentsFor(rest,['--title','--status','--step','--total-steps','--timer'],['--sensitive']);
    if(args.positional.length!==2)throw new Error('Use nb activity <id> <start|update|end|poll> --to <name>');
    const route=(await createDestinationRouter(routing,store)).resolve();
    const result=await withShutdown(signal=>route.client.activity({activityId:args.positional[0],action:args.positional[1] as 'start'|'update'|'end'|'poll',
      title:args.text('--title'),status:args.text('--status'),step:args.number('--step'),totalSteps:args.number('--total-steps'),
      timerMinutes:args.number('--timer'),sensitive:args.flag('--sensitive')||undefined},{signal}));
    console.log(JSON.stringify({...result,to:route.name,connectionId:route.record.connectionId},null,2));return;
  }
  throw new Error('Unknown command. Run nb help for usage.');
}
main().catch(err=>{console.error(`NotiBuddy: ${err.message}`);process.exitCode ??= 1;});
