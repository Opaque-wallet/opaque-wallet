// MoonPay checkout URLs, signed here, for coins delivered straight into a pool
// under a fresh destination tag.
//
// Opaque never mints and never sells: MoonPay does the KYC and the payment, and
// pays the pool account with the wallet's tag. MoonPay therefore knows who
// bought, how much, when, and the tag; the ledger shows MoonPay paying the pool.
//
// The URL is built from STRUCTURED FIELDS ONLY — a pool from the compiled-in
// deployment, a fiat amount, a tag — and never from a URL or a parameter the
// caller supplies. Signing whatever it was handed would make this a signing
// oracle for any wallet address MoonPay would accept.
//
// Signature (dev.moonpay.com, URL signing): base64 HMAC-SHA256 under the
// secret key of the URL's query string, "?" included, with every value already
// URL-encoded; appended last as &signature=<URL-encoded signature>.

import { createHmac } from 'node:crypto';

import { ProtocolFailure } from '@opaque/protocol-types';

export const MOONPAY_SANDBOX = 'https://buy-sandbox.moonpay.com';
export const MOONPAY_LIVE = 'https://buy.moonpay.com';

export interface CheckoutConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** MOONPAY_SECRET_KEY. Never logged, never sent anywhere but into the HMAC. */
  readonly secretKey: string;
  readonly fiatCurrency?: string;
  readonly minFiat?: number;
  readonly maxFiat?: number;
}

export interface Checkout {
  /** MoonPay's code for the coin on XRPL ('xrp'). */
  readonly currencyCode: string;
  /** The pool account the coins are delivered to. From the deployment, never the caller. */
  readonly walletAddress: string;
  readonly walletAddressTag: number;
  /** Whole units of fiat. */
  readonly fiatAmount: number;
}

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };

export const signQuery = (query: string, secretKey: string): string =>
  createHmac('sha256', secretKey).update(query).digest('base64');

export function checkoutUrl(config: CheckoutConfig, checkout: Checkout): string {
  const { minFiat = 20, maxFiat = 5_000 } = config;
  if (!/^[a-z0-9_]{2,20}$/.test(checkout.currencyCode)) refuse('unknown currency code');
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(checkout.walletAddress)) refuse('the wallet address must be a pool account');
  if (!Number.isInteger(checkout.walletAddressTag) || checkout.walletAddressTag < 1 || checkout.walletAddressTag > 0xffff_ffff) refuse('a tag is 1 to 2^32-1');
  if (!Number.isInteger(checkout.fiatAmount) || checkout.fiatAmount < minFiat || checkout.fiatAmount > maxFiat) refuse(`buy between ${minFiat} and ${maxFiat}`);
  const params = new URLSearchParams({
    apiKey: config.apiKey,
    currencyCode: checkout.currencyCode,
    walletAddress: checkout.walletAddress,
    walletAddressTag: String(checkout.walletAddressTag),
    baseCurrencyCode: config.fiatCurrency ?? 'usd',
    baseCurrencyAmount: String(checkout.fiatAmount),
  });
  const query = `?${params.toString()}`;
  return `${config.baseUrl}/${query}&signature=${encodeURIComponent(signQuery(query, config.secretKey))}`;
}
