/** Canonical transport and persistence identity. Paths remain significant. */
export function normalizeRelay(value:string):string {
  const url=new URL(value);
  if(url.username || url.password || url.search || url.hash ||
    url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Relay requires HTTPS without credentials, query, or fragment');
  return url.toString().replace(/\/+$/,'');
}
