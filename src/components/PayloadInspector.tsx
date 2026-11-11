'use client';

import { useState } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { pharosAtlantic } from '@/lib/chain';
import { ERC20_ABI, VAULT_ABI } from '@/lib/abis';
import type { Address } from 'viem';
import type { HarborActionPlan } from '@/lib/types';
import { shortAddress } from '@/lib/format';

/* Non-custodial Unsigned Payload Inspector + wallet execution.
   The agent core produced these payloads; the USER's wallet is the only
   signer. Each leg is submitted sequentially with its receipt displayed. */

export function PayloadInspector({ plan, user }: { plan: HarborActionPlan | null; user: Address | null }) {
  const [copied, setCopied] = useState<number | null>(null);
  const [receipts, setReceipts] = useState<string[]>([]);
  const { writeContractAsync } = useWriteContract();
  const { chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();

  if (!plan) {
    return (
      <section className="harbor-panel p-5">
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-cyan-300">NON-CUSTODIAL UNSIGNED PAYLOAD INSPECTOR</h2>
        <p className="text-xs text-slate-500">
          Prepared actions appear here as raw ABI-encoded unsigned transactions (to / data / value / chainId / gasEstimate /
          harborRouteCommitment). The agent core never signs - your wallet does.
        </p>
      </section>
    );
  }

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(idx);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  const signLeg = async (index: number) => {
    const leg = plan.legs[index];
    if (!leg) return;
    try {
      if (chainId !== pharosAtlantic.id) {
        switchChain({ chainId: pharosAtlantic.id });
        return;
      }
      const amount = BigInt(leg.amountRaw ?? '0');
      let hash: string;
      if (leg.kind === 'approve') {
        hash = await writeContractAsync({
          address: leg.to,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [plan.selectedVault as Address, amount],
        });
      } else if (leg.kind === 'deposit') {
        hash = await writeContractAsync({
          address: leg.to,
          abi: VAULT_ABI,
          functionName: 'deposit',
          args: [amount, (user ?? plan.user) as Address],
        });
      } else {
        hash = await writeContractAsync({
          address: leg.to,
          abi: VAULT_ABI,
          functionName: 'withdraw',
          args: [amount, (user ?? plan.user) as Address],
        });
      }
      setReceipts((r) => [...r, `leg[${index}] ${leg.kind} -> ${hash}`]);
    } catch (e) {
      setReceipts((r) => [...r, `leg[${index}] ${leg.kind} FAILED -> ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  return (
    <section className="harbor-panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-cyan-300">NON-CUSTODIAL UNSIGNED PAYLOAD INSPECTOR</h2>
        <span className="harbor-badge">{plan.action} · {plan.legs.length} leg(s)</span>
      </div>

      <div className="mb-3 grid gap-2 text-[11px] font-mono md:grid-cols-2">
        <Field label="harborRouteCommitment" value={plan.harborRouteCommitment} />
        <Field label="selectedVault" value={plan.selectedVault} />
        <Field label="user" value={plan.user} />
        <Field label="amount (6dp units)" value={plan.amount.toString()} />
      </div>

      <div className="space-y-3">
        {plan.legs.map((leg, i) => (
          <div key={i} className="rounded-lg border border-cyan-500/15 bg-black/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="harbor-badge">
                leg[{i}] {leg.kind}
              </span>
              <div className="flex gap-2">
                <button className="harbor-btn px-3 py-1 text-[11px]" onClick={() => copy(JSON.stringify(leg, null, 2), i)}>
                  {copied === i ? 'Copied' : 'Copy JSON'}
                </button>
                {isConnected && (
                  <button className="harbor-btn px-3 py-1 text-[11px] font-semibold" onClick={() => signLeg(i)}>
                    Sign leg[{i}] with wallet
                  </button>
                )}
              </div>
            </div>
            <pre className="harbor-scroll max-h-48 overflow-auto text-[10px] leading-relaxed text-slate-400">
              {JSON.stringify(
                {
                  to: leg.to,
                  data: leg.data,
                  value: leg.value,
                  chainId: leg.chainId,
                  gasEstimate: leg.gasEstimate,
                  harborRouteCommitment: leg.harborRouteCommitment,
                  amountRaw: leg.amountRaw,
                },
                null,
                2,
              )}
            </pre>
            <p className="mt-1 text-[10px] text-slate-500">{leg.humanSummary}</p>
          </div>
        ))}
      </div>

      {receipts.length > 0 && (
        <div className="mt-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-3 font-mono text-[11px] text-emerald-200">
          {receipts.map((r, i) => (
            <div key={i} className="truncate">
              {r.startsWith('leg') && r.includes('FAILED') ? `⚠ ${r}` : `✓ ${r}`}
            </div>
          ))}
        </div>
      )}

      {!isConnected && (
        <p className="mt-3 text-[11px] text-slate-500">
          Wallet not connected - use "Copy JSON" to execute in any external wallet, or connect an injected wallet (Atlantic
          688689) and sign here. {user ? '' : shortAddress(plan.user)}
        </p>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-cyan-500/10 bg-black/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="truncate text-cyan-200" title={value}>
        {value}
      </div>
    </div>
  );
}
