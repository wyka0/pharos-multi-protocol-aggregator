import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // @wagmi/connectors -> @base-org/account -> @coinbase/cdp-sdk optionally
    // imports @x402/* packages that are not installed. The Harbor console only
    // uses the injected connector, so those optional modules are never
    // executed - stub them out at bundle time.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@x402/evm': false,
      '@x402/core': false,
      '@x402/fetch': false,
      '@x402/svm': false,
    };
    return config;
  },
};

export default nextConfig;
