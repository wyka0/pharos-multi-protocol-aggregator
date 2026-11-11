import { NextResponse } from 'next/server';
import { getHarborServer } from '@/lib/server/aggregator-instance';

/* GET /api/venues - live 3-vault rate matrix + venue health snapshot. */

export async function GET() {
  const server = getHarborServer();
  if (!server.aggregator) {
    return NextResponse.json(
      {
        configured: false,
        configError: server.configError,
        venues: [],
        health: [],
        chain: { id: server.chainId, rpcUrl: server.rpcUrl, explorer: 'https://atlantic.pharosscan.xyz' },
      },
      { status: 200 },
    );
  }

  try {
    const rates = await server.aggregator.compareRates(30);
    return NextResponse.json(
      {
        configured: true,
        venues: rates.venues,
        health: rates.excluded,
        allHealth: server.aggregator.mesh.healthSnapshot(),
        chain: { id: server.chainId, rpcUrl: server.rpcUrl, explorer: 'https://atlantic.pharosscan.xyz' },
      },
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      {
        configured: true,
        degraded: true,
        venues: [],
        health: [],
        error: e instanceof Error ? e.message : String(e),
        chain: { id: server.chainId, rpcUrl: server.rpcUrl, explorer: 'https://atlantic.pharosscan.xyz' },
      },
      { status: 200 },
    );
  }
}
