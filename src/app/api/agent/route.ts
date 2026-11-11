import { NextResponse } from 'next/server';
import { getHarborServer } from '@/lib/server/aggregator-instance';
import { jsonSafe } from '@/lib/json';
import type { Address } from 'viem';

/* ========================================================================== */
/* POST /api/agent - the unified Harbor entrypoint (queries + prepared         */
/* non-custodial actions). NEVER returns HTTP 5xx: fault isolation is part of  */
/* the API contract (Requirement 04).                                          */
/*                                                                            */
/* Body: { input?: string, structured?: object, user?: address, horizonDays? } */
/* ========================================================================== */

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Request body must be JSON.', venueHealth: [], degradedMode: false, parsedAt: Date.now() },
      { status: 400 },
    );
  }

  const { input, structured, user, horizonDays } = (body ?? {}) as {
    input?: string;
    structured?: unknown;
    user?: string;
    horizonDays?: number;
  };

  const server = getHarborServer();
  if (!server.aggregator) {
    return NextResponse.json(
      {
        ok: false,
        intent: { kind: 'unknown', raw: input ?? '', confidence: 0, matched: [], hint: server.configError ?? 'not configured' },
        mode: 'query',
        venueHealth: [],
        degradedMode: true,
        banner: server.configError ?? undefined,
        error: server.configError ?? undefined,
        parsedAt: Date.now(),
      },
      { status: 200 },
    );
  }

  const safeUser =
    typeof user === 'string' && /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Address) : null;

  try {
    const response = await server.aggregator.handle({
      text: typeof input === 'string' ? input : undefined,
      structured,
      user: safeUser,
      horizonDays: typeof horizonDays === 'number' && horizonDays >= 1 && horizonDays <= 3650 ? horizonDays : undefined,
    });
    return NextResponse.json(jsonSafe(response), { status: 200 });
  } catch (e) {
    // Belt-and-braces: even a bug in the core must degrade gracefully.
    return NextResponse.json(
      {
        ok: false,
        mode: 'query',
        venueHealth: [],
        degradedMode: true,
        banner: 'DEGRADED MODE: agent core fault contained.',
        error: e instanceof Error ? e.message : String(e),
        parsedAt: Date.now(),
      },
      { status: 200 },
    );
  }
}
