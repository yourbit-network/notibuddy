import { DestinationStore, destinationName, senderLabel } from './config.js';
import { NotiBuddyClient } from './client.js';
import { FileInbox } from './files.js';
import { PendingStore } from './pending-store.js';

export interface RoutingOptions { to?:string; allowTo?:string[]; sender?:string }
export function parseRoutingArgs(args:string[]): {options:RoutingOptions; rest:string[]} {
  const options:RoutingOptions={}, rest:string[]=[];
  for(let i=0;i<args.length;i++) {
    const [flag,inline]=args[i].split(/=(.*)/s,2);
    if (!['--to','--allow-to','--sender'].includes(flag)) { rest.push(args[i]); continue; }
    const value=inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag==='--allow-to') (options.allowTo ??= []).push(destinationName(value));
    else if (flag==='--to') {
      if (options.to) throw new Error('Specify --to only once');
      options.to=destinationName(value);
    } else {
      if (options.sender) throw new Error('Specify --sender only once');
      options.sender=senderLabel(value);
    }
  }
  if(options.to && options.allowTo) throw new Error('Choose --to for one destination or --allow-to for a selectable list, not both');
  return {options,rest};
}

/** Snapshot only explicitly exposed connections; later config edits cannot redirect this process. */
export async function createDestinationRouter(options:RoutingOptions,store=new DestinationStore()) {
  const names=options.to ? [destinationName(options.to)] : options.allowTo?.map(destinationName);
  if (options.to && options.allowTo) throw new Error('Choose --to or --allow-to, not both');
  if (!names?.length) throw new Error('Select a destination explicitly: --to <name>, or repeat --allow-to <name> for MCP. Run nb devices list; import old setup with nb devices migrate --to <name>.');
  if(new Set(names).size!==names.length) throw new Error('Destination allowlist contains duplicates');
  const label=senderLabel(options.sender);
  const entries=await Promise.all(names.map(async name=>{
    const {record,signingKey}=await store.open(name);
    return {name,record,files:new FileInbox(record,signingKey,store.root),client:new NotiBuddyClient(record.config,signingKey,new PendingStore(record.config,store.root),label)};
  }));
  return {
    selectable:!options.to,
    names,
    list:()=>entries.map(({name,record})=>({to:name,deviceName:record.config.device.name || 'iPhone',
      deviceId:record.config.device.id,connectionId:record.connectionId,connectionLabel:record.config.senderLabel,
      sender:label,status:'saved_pairing',acceptsNewMessages:false,acceptsFiles:!!record.fileKey})),
    resolve(to?:string) {
      if (options.to && to && to!==options.to) throw new Error(`This server is pinned to '${options.to}'`);
      const selected=to ?? options.to;
      if(!selected) throw new Error(`Select 'to' explicitly: ${names.join(', ')}`);
      const entry=entries.find(e=>e.name===selected);
      if(!entry) throw new Error('Destination is not exposed by this server');
      return entry;
    },
  };
}
