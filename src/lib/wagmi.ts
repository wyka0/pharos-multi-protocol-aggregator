import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { pharosAtlantic } from './chain';

/* ========================================================================== */
/* wagmi v2 config for Pharos Atlantic Testnet (chainId 688689).               */
/* The agent NEVER signs; this config exists purely so the USER's browser      */
/* wallet can review + sign the prepared unsigned payloads in the UI.          */
/* ========================================================================== */

export const wagmiConfig = createConfig({
  chains: [pharosAtlantic],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [pharosAtlantic.id]: http('https://atlantic.dplabs-internal.com'),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
