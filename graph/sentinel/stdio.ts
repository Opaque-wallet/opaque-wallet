import { serveSentinel } from './server.ts';
import { loadLiveCompanionContext } from './live-context.ts';

// A read-only stdio MCP server. It receives no payment arguments and delegates
// exclusively to the public Graph Client companion.
await serveSentinel(loadLiveCompanionContext);
