import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

/* GET /api/evidence - expose deterministic verification evidence (if the      */
/* reviewer has run scripts/verify-onchain.ts) plus the deployment record.     */

export async function GET() {
  const evidenceDir = path.join(process.cwd(), 'evidence');
  const evidencePath = path.join(evidenceDir, 'aggregator-evidence.json');
  const deploymentPath = path.join(evidenceDir, 'deployment.json');

  const readJson = (p: string): unknown | null => {
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };

  return NextResponse.json({
    present: fs.existsSync(evidencePath),
    evidence: readJson(evidencePath),
    deployment: readJson(deploymentPath),
  });
}
