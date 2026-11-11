import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Harbor - Pharos Multi-Protocol Aggregator',
  description:
    'Harbor-style cross-vault query & non-custodial action router unifying 3 on-chain protocols on Pharos Atlantic Testnet (chainId 688689).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#05080f] text-slate-200 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
