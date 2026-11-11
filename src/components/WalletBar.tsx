'use client';

import { useAccount, useConnect, useSwitchChain } from 'wagmi';
import { pharosAtlantic } from '@/lib/chain';
import { shortAddress } from '@/lib/format';

export function WalletBar() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();

  return (
    <div className="flex items-center gap-3">
      {isConnected && address ? (
        <>
          <span className="harbor-badge" style={chainId !== pharosAtlantic.id ? { borderColor: '#f59e0b', color: '#fbbf24' } : undefined}>
            {chainId === pharosAtlantic.id ? 'Atlantic 688689' : `wrong chain ${chainId ?? '?'}`}
          </span>
          {chainId !== pharosAtlantic.id && (
            <button className="harbor-btn px-3 py-1.5 text-xs" onClick={() => switchChain({ chainId: pharosAtlantic.id })}>
              Switch to Atlantic
            </button>
          )}
          <span className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-3 py-1.5 font-mono text-xs text-cyan-200">
            {shortAddress(address)}
          </span>
        </>
      ) : (
        <button
          className="harbor-btn px-4 py-1.5 text-xs font-semibold"
          disabled={isPending}
          onClick={() => {
            const injected = connectors.find((c) => c.id === 'injected') ?? connectors[0];
            if (injected) connect({ connector: injected });
          }}
        >
          Connect Wallet (to sign payloads)
        </button>
      )}
    </div>
  );
}
