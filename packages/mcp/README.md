# @opaque/mcp

Opaque for AI agents: a local MCP server holding a wallet of the agent's own.
It pays privately on Arc and the XRP Ledger within limits you set, and asks you
in the client before anything larger. https://www.opaque.credit/developers#mcp

```sh
opaque-mcp init                                     # an account of the agent's own, with limits
security add-generic-password -s opaque-mcp -a "$USER" -T "" -w      # its password; the keychain asks on every read
claude mcp add opaque -- opaque-mcp serve --password-command "security find-generic-password -s opaque-mcp -w"
opaque-mcp policy --set policy.json                 # change the limits (with the password)
opaque-mcp deployer-key 0                           # a deployer's key, in your terminal only
```

- The agent sees amounts, addresses and handles; never a key, a note or the phrase.
- Payments have limits per payment and per day; account operations a daily count; a call that hands tokens over, or to a contract the agent didn't deploy, asks you.
- Never put the password in the client's config: an agent that runs commands can read it there.
- `get_deployer_key` writes `PRIVATE_KEY` into a git-ignored `.env` (mode 600) after you approve; the key never enters the conversation.
- `npm test` (unit, through a real MCP client), `npm run e2e` (Arc testnet).

Licensed, not open source: see LICENSE.
