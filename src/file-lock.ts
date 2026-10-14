import fs from 'node:fs';

/** Short exclusive local operation; recover a previous process's lock only when that PID is gone. */
export function acquireFileLock(file:string):()=>void {
  const take=()=>fs.writeFileSync(file,String(process.pid),{mode:0o600,flag:'wx'});
  const dead=()=>{
    const owner=fs.readFileSync(file,'utf8');
    if(!/^[1-9][0-9]*$/.test(owner))return false;
    try{process.kill(Number(owner),0);return false;}
    catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
  };
  try{take();}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const recovery=file+'.recovery';
    try{fs.mkdirSync(recovery,{mode:0o700});}
    catch{throw new Error('Another process is recovering this operation. Retry when it finishes.');}
    try {
      if(!dead())throw new Error('Another process owns this operation. Retry when it finishes. If a crash left an incomplete lock, verify no receiver is running before removing the .lock file.');
      fs.unlinkSync(file);take();
    } finally {fs.rmdirSync(recovery);}
  }
  return ()=>fs.unlinkSync(file);
}
