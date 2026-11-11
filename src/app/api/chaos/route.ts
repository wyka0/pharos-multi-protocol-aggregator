import { NextResponse } from 'next/server';
import { getChaosRegistry } from '@/lib/chaos';
import { getHarborServer } from '@/lib/server/aggregator-instance';
import { jsonSafe } from '@/lib/json';
import { PROTOCOL_IDS, type ProtocolId } from '@/lib/types';

/* ========================================================================== */
/* Chaos toggle API (UI "Protocol Chaos / Outage" panel).                      */
/*  GET  -> current forced outages + live venue health snapshot.               */
/*  POST -> { protocolId, kind?: 'TIMEOUT'|'RPC_REVERT'|'PAUSED', clear? }     */
/* ========================================================================== */

function isProtocolId(v: unknown): v is ProtocolId {
  return typeof v === 'string' && (PROTOCOL_IDS as readonly string[]).includes(v);
}

export async function GET() {
  const chaos = getChaosRegistry();
  const server = getHarborServer();
  return NextResponse.json(jsonSafe({
    forced: chaos.list(),
    health: server.aggregator ? server.aggregator.mesh.healthSnapshot() : [],
  }));
}

export async function POST(req: Request) {
  let body: { protocolId?: string; kind?: string; clear?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const chaos = getChaosRegistry();

  if (body.clear || body.protocolId === undefined) {
    if (body.protocolId && isProtocolId(body.protocolId)) {
      chaos.clear(body.protocolId);
    } else {
      chaos.clearAll();
    }
    return NextResponse.json({ ok: true, forced: chaos.list() });
  }

  if (!isProtocolId(body.protocolId)) {
    return NextResponse.json({ ok: false, error: `protocolId must be one of ${PROTOCOL_IDS.join(', ')}` }, { status: 400 });
  }

  const kind = body.kind === 'RPC_REVERT' || body.kind === 'PAUSED' ? body.kind : 'TIMEOUT';
  chaos.setForced(body.protocolId, kind);
  return NextResponse.json({ ok: true, forced: chaos.list() });
}
