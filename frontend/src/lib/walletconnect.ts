// WalletConnect for the XRPL wallet: dapps on any wallet SDK that speaks
// WalletConnect's XRPL methods (xrpl-connect's WalletConnect adapter among
// them), not only those that load Opaque's own adapter.
//
//   relay      reached THROUGH the Opaque service (backend/xrpl/stack.ts tunnels
//              the socket to Reown's relay byte for byte): this page talks to
//              its own origin and Opaque's stack only, and Reown sees Opaque's
//              server, never you. Messages are end-to-end encrypted between the
//              dapp and this page.
//   verify     Reown's check that the dapp is the site it claims, through the
//              service the same way. VALID: the dapp shares the account its
//              origin has through the popup. Anything else: an account of its
//              own, and the card says the address is unverified. A known scam
//              is refused outright.
//   methods    xrpl_signTransaction: submit (the default) is signAndSubmit, the
//              key rotating in the same Batch; submit false is sign only.
//              Opaque fills Sequence, Fee and LastLedgerSequence itself, whatever
//              `autofill` says. xrpl_signTransactionFor is refused: no site
//              account is anyone's multisigner.
//   telemetry  off.
//
// The library is loaded only when this is used, and pinned (package.json):
// the Verify redirect below sets two of its internals.

import type { SessionTypes, SignClientTypes } from '@walletconnect/types';

export interface WalletConnectConfig { readonly projectId: string; readonly relayUrl: string; readonly verifyUrl: string }

export interface Proposal {
  readonly name: string;
  /** Where the account is kept: the verified origin, or `walletconnect:<claimed origin>`. */
  readonly siteKey: string;
  /** What the dapp says it is. */
  readonly claimed: string;
  readonly verified: boolean;
}

export interface WalletConnectHandlers {
  /** A new session: the address to share, or null to refuse. */
  connect(p: Proposal): Promise<string | null>;
  /** One transaction, approved or refused by the user: the signed tx_json with its hash. */
  request(siteKey: string, method: 'sign' | 'signAndSubmit', tx: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The site key of the account a session holds, if this browser has it. */
  siteOf(address: string): string | undefined;
}

const originOf = (url: string): string => {
  try { return new URL(url).origin; } catch { return 'unknown'; }
};

export async function startWalletConnect(config: WalletConnectConfig, chainId: string, handlers: WalletConnectHandlers): Promise<{ pair(uri: string): Promise<void> }> {
  const [{ SignClient }, { buildApprovedNamespaces, getSdkError }] = await Promise.all([import('@walletconnect/sign-client'), import('@walletconnect/utils')]);
  const client = await SignClient.init({
    projectId: config.projectId, relayUrl: config.relayUrl, telemetryEnabled: false,
    metadata: { name: 'Opaque', description: 'Private XRPL accounts, one per app', url: location.origin, icons: [] },
  });
  // Verify's two reads go to the service, which asks Reown (pinned version; the internals are its own).
  const verify = client.core.verify as unknown as { getVerifyUrl: () => string; verifyUrlV3: string };
  verify.getVerifyUrl = () => config.verifyUrl;
  verify.verifyUrlV3 = `${config.verifyUrl}/v3`;

  client.on('session_proposal', async ({ id, params, verifyContext }: SignClientTypes.EventArguments['session_proposal']) => {
    const v = verifyContext.verified;
    const claimed = originOf(params.proposer.metadata.url);
    const verified = v.validation === 'VALID' && v.origin !== undefined && originOf(v.origin) === claimed;
    try {
      if (v.isScam === true) throw new Error('Reown lists this app as a scam');
      const address = await handlers.connect({ name: params.proposer.metadata.name, siteKey: verified ? claimed : `walletconnect:${claimed}`, claimed, verified });
      if (address === null) throw new Error('rejected in Opaque');
      const namespaces: SessionTypes.Namespaces = buildApprovedNamespaces({
        proposal: params,
        supportedNamespaces: {
          xrpl: { chains: [chainId], methods: ['xrpl_signTransaction', 'xrpl_signTransactionFor'], events: ['chainChanged', 'accountsChanged'], accounts: [`${chainId}:${address}`] },
        },
      });
      await client.approve({ id, namespaces });
    } catch {
      await client.reject({ id, reason: getSdkError('USER_REJECTED') }).catch(() => undefined);
    }
  });

  client.on('session_request', async ({ id, topic, params }: SignClientTypes.EventArguments['session_request']) => {
    const respond = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      client.respond({ topic, response: { id, jsonrpc: '2.0', ...body } }).catch(() => undefined);
    try {
      const address = client.session.get(topic).namespaces['xrpl']?.accounts[0]?.split(':')[2] ?? '';
      const siteKey = handlers.siteOf(address);
      if (siteKey === undefined) throw new Error('this browser does not hold that account');
      if (params.chainId !== chainId) throw new Error(`Opaque is on ${chainId}`);
      if (params.request.method !== 'xrpl_signTransaction') {
        await respond({ error: getSdkError('UNSUPPORTED_METHODS', params.request.method) });
        return;
      }
      const { tx_json: tx, submit } = (params.request.params ?? {}) as { tx_json?: Record<string, unknown>; submit?: boolean };
      if (typeof tx !== 'object' || tx === null) throw new Error('xrpl_signTransaction takes { tx_json }');
      await respond({ result: { tx_json: await handlers.request(siteKey, submit === false ? 'sign' : 'signAndSubmit', tx) } });
    } catch (error) {
      await respond({ error: { code: getSdkError('USER_REJECTED').code, message: (error as Error).message } });
    }
  });

  return { pair: async (uri) => { await client.core.pairing.pair({ uri }); } };
}
