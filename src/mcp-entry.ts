#!/usr/bin/env node
import { runMcpServer } from './mcp.js';
import { parseRoutingArgs } from './routing.js';
async function main() {
  const {options,rest}=parseRoutingArgs(process.argv.slice(2));
  if(rest.length)throw new Error('Unknown MCP arguments. Use --to <name> or repeat --allow-to <name>, with optional --sender <label>.');
  await runMcpServer(options);
}
main().catch(err=>{process.stderr.write(`Fatal MCP error: ${err.message}\n`);process.exitCode=1;});
