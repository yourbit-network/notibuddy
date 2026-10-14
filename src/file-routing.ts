import { DestinationStore } from './config.js';
import { FileInbox } from './files.js';

/** Phone-generated commands select public identities, never a guessed local alias. */
export async function resolveFileDestination(options:{to?:string;pairing?:string},store=new DestinationStore()) {
  if(options.to && options.pairing)throw Error('Choose --to or --pairing, not both.');
  if(!options.to && !options.pairing)throw Error('Choose a destination with --to <name>, or use the receive command copied from NotiBuddy.');
  let name=options.to;
  let expected:{deviceId:string;senderKeyId:string}|undefined;
  if(options.pairing!==undefined) {
    const match=/^(dev_[a-f0-9]{24}):(snd_[a-f0-9]{24})$/.exec(options.pairing);
    if(!match || match[0]!==options.pairing)throw Error('Invalid pairing selector. Copy the receive command from NotiBuddy again.');
    expected={deviceId:match[1],senderKeyId:match[2]};
    const matches=store.list().filter(summary=>{
      if(summary.deviceId!==expected!.deviceId)return false;
      return store.read(summary.name).config.senderKeyId===expected!.senderKeyId;
    });
    if(matches.length===0)throw Error('This device and sender key are not paired here. Run the command where you approved this sender; use nb devices list to inspect local destinations.');
    if(matches.length>1)throw Error('Multiple local destinations match this pairing. Inspect nb devices list and select the intended alias with --to <name>.');
    name=matches[0].name;
  }
  const {record,signingKey}=await store.open(name!);
  // Re-read/validate through open: an alias replacement during async key checks
  // must never turn identity selection into authority for another destination.
  if(expected && (record.config.device.id!==expected.deviceId || record.config.senderKeyId!==expected.senderKeyId))throw Error('The destination changed while selecting this pairing. Copy the command again and retry.');
  return {name:name!,record,files:new FileInbox(record,signingKey,store.root)};
}
