'use client';

import { useState } from 'react';

const PRESETS = [
  'Show my positions and current APY across all vaults',
  'Compare yield rates and available liquidity',
  'Deposit 500 USDC into the best yield vault',
  'Deposit 25,000 USDC for 14 days',
  'Withdraw 200 USDC from my lowest-yielding position',
  'Withdraw 800 USDC',
];

export function CommandBar({ onRun, running }: { onRun: (input: string) => void; running: boolean }) {
  const [value, setValue] = useState('');

  return (
    <section className="harbor-panel p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-cyan-300">HARBOR NL COMMAND BAR</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onRun(value.trim());
        }}
      >
        <input
          className="harbor-input flex-1 px-4 py-2.5 font-mono text-sm text-cyan-100 placeholder:text-slate-600"
          placeholder='Try: "Deposit 500 USDC into the best yield vault"'
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="harbor-btn px-5 py-2.5 text-sm font-semibold" disabled={running || value.trim().length === 0} type="submit">
          {running ? 'Routing...' : 'Execute'}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            className="rounded-full border border-cyan-500/20 bg-cyan-500/5 px-3 py-1 text-[11px] text-cyan-200/80 transition hover:border-cyan-400/50 hover:text-cyan-100"
            onClick={() => onRun(p)}
            type="button"
          >
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}
