import { NETWORK } from '../../../deployments/index.ts';

/**
 * A browser-storage name for this build's network. Mainnet and testnet share
 * one origin (opaque.credit and opaque.credit/testnet), and a few-time FORS key
 * must never sign on two chains, so each network keeps its own keys and notes.
 * Testnet keeps the original names: opaque.credit WAS testnet, so whatever a
 * browser already holds there is testnet's.
 */
export const scoped = (name: string): string => (NETWORK === 'testnet' ? name : `${name}@${NETWORK}`);
