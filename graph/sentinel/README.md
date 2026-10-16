# Opaque Privacy Sentinel

Privacy Sentinel is an independent, read-only public Graph companion. It never
accepts a payment, note, recipient, route, proof, key, sealed CRE intent, or
authorization. Its three MCP tools explain public privacy conditions only.

## Deploy as an isolated Railway service

This is deliberately a **separate** Railway service from Opaque's relay/CRE
stack. It has no signer, chain RPC, payment routes, CRE secrets, or shared
database.

### Railway configuration

Create a Railway service from this repository and set:

| Railway setting | Value |
| --- | --- |
| Builder | Dockerfile |
| Dockerfile path | `graph/sentinel/Dockerfile` |
| Build context | repository root |
| Healthcheck path | `/healthz` |
| Public networking | enabled |

Set one service variable, using Railway's secret-variable UI:

```text
GRAPH_GATEWAY_API_KEY=<your Graph Network gateway key>
```

Railway supplies `PORT`. Do not set, copy, or reuse Opaque's payment-stack
secrets (`MESH_MASTER`, `CREDENTIAL_MAC`, intent keys, deployer keys, or RPC
credentials) here.

At startup, the service generates its Graph Client artifact from the injected
Gateway key, then starts a stateless HTTP MCP server:

```text
GET  /healthz  → source configuration only; never a secret
POST /mcp      → Streamable HTTP MCP
```

### Verify after Railway gives you a public URL

```bash
curl -sS https://<sentinel-domain>/healthz
```

Expected fields:

```json
{
  "service": "opaque-privacy-sentinel",
  "status": "ok",
  "opaqueStudio": "public",
  "graphNetwork": "configured",
  "mcp": "/mcp"
}
```

The public MCP endpoint is `https://<sentinel-domain>/mcp`. Put that URL in
`mcpEndpoint` in [`agent0-registration.json`](./agent0-registration.json)
before performing the separate Agent0 / ERC-8004 registration on Base Sepolia.
