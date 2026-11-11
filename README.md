# ⚓ Pharos Multi-Protocol Aggregator — Harbor-Style Cross-Vault Query & Non-Custodial Action Router

> **Pharos Atlantic Testnet · chainId `688689` · RPC `https://atlantic.dplabs-internal.com`**
> Next.js 15 · TypeScript (strict) · Tailwind v4 · viem · wagmi v2 · vitest (311 tests) · solc

One unified Harbor interface over **three distinct on-chain protocols** — query positions & rates across
all of them in a single request, and get **non-custodial, ABI-encoded unsigned deposit/withdraw payloads**
routed to the mathematically best venue, with cryptographically bound route proofs and graceful
degradation when any protocol goes down.

📄 **Deep-dive: [ARCHITECTURE.md](ARCHITECTURE.md)** — full topology, adapter contracts, routing math,
fault-isolation state machine, airgap + commitment design, and sequence diagrams.

<!-- RECEIPTS:START -->
### PharosScan Receipts (live, chainId 688689)

| Artifact | Link |
| --- | --- |
| Suite deploy tx | [0xf2bd93fb2602f1270c1f...](https://atlantic.pharosscan.xyz/tx/0xf2bd93fb2602f1270c1ff5985b77cc01cf329ad1023e0b73760c432325d585b1) |
| Scenario 2 - optimal deposit 500 USDC | [0x6680f52087eb5a3b33c9...](https://atlantic.pharosscan.xyz/tx/0x6680f52087eb5a3b33c9cd03e7fb5670f06c65a6ccafafb5ef48d1d67614d660) |
| Scenario 2 - route commitment anchor | [0x58510f938620ed83a7a8...](https://atlantic.pharosscan.xyz/tx/0x58510f938620ed83a7a893c2dd25606abfd377c86be631f49d583b0c7cab35e0) |
| Scenario 3 - failover deposit (2 venues down) | [0x8e29b159422a5d659a2a...](https://atlantic.pharosscan.xyz/tx/0x8e29b159422a5d659a2a50b427b4037b47614be59553e38c9c613ade3b4a55b9) |
| Scenario 4 - optimal withdrawal 200 USDC | [0x784d12caf073f53dbb51...](https://atlantic.pharosscan.xyz/tx/0x784d12caf073f53dbb51c7068c13c2c951c70cfe49524b270270b22a1c3f6923) |
| Scenario 4b - split withdrawal legs | [0x3047781c8e1d...](https://atlantic.pharosscan.xyz/tx/0x3047781c8e1d77dea65d3dd9a1765ac0c319d1b6d75a384b0c4f8d1c6c4e0780) · [0x0c094d5ec534...](https://atlantic.pharosscan.xyz/tx/0x0c094d5ec5342e73ec7b6b108af004fbaa03f84b39ea85561cb9781d7cf8d542) |
| Full evidence | [evidence/aggregator-evidence.json](evidence/aggregator-evidence.json) · [SUBMISSION_EVIDENCE.md](SUBMISSION_EVIDENCE.md) |
<!-- RECEIPTS:END -->

---

## What it does

| Requirement | Implementation |
| --- | --- |
| **01 — 3 protocols, 1 interface** | Self-contained `PharosVaultSuite.sol` (deployed on Atlantic) wrapping **HarborLendVault** (ERC-4626 kinked-utilization lending, 0/5 bps fees), **AtlanticPrimeStaking** (940 bps tiered staking, 10/0 bps, capacity dilution), **PharosRwaTreasury** (stable 780 bps T-Bill, 0/0 fees, on-chain pause) — all behind one `IVaultAdapter` and one UI. |
| **02 — unified queries + non-custodial actions** | `"Show my positions and current APY across all vaults"` → single aggregated view. `"Deposit 500 USDC into the best yield vault"` → human-readable confirmation card + raw unsigned payload (`to/data/value/chainId/gasEstimate/harborRouteCommitment`) for the wallet to sign. The agent core in `src/` never signs, never broadcasts, never touches keys (enforced by source-scan tests). |
| **03 — best venue + why** | Deterministic `VenueScoringEngine`: `NetExpectedYield(dx,T) = dx·(1−fee)·PostDepositAPY(dx)·T/365 − EntryFeeCost − GasUSDC` with per-vault utilization-response models. Every route ships a `RoutingRationale` naming the winner **and** each runner-up's dollar-denominated rejection reason. |
| **04 — graceful degradation** | `ResilientAdapterMesh`: `Promise.allSettled` + per-adapter timeouts + per-protocol circuit breakers (`HEALTHY → DEGRADED_TIMEOUT → CIRCUIT_OPEN → half-open probe`) + on-chain-pause mapping. One (or two!) protocols down → queries keep serving the survivors with an explicit degraded-mode banner; deposits/withdrawals re-route automatically. The API contract never returns 5xx. |
| **05 — docs** | [ARCHITECTURE.md](ARCHITECTURE.md) with Mermaid topology, math, state machines, 4 sequence diagrams; this README with the live PharosScan receipt table; auto-generated [SUBMISSION_EVIDENCE.md](SUBMISSION_EVIDENCE.md) + `evidence/aggregator-evidence.json`. |

## The 4 innovations

| # | Innovation | Where |
| --- | --- | --- |
| 1 | **Post-deposit utilization & fee-adjusted net-yield optimizer** — models `U' = debt/(cash+dx)` (Harbor), `U' = (deposits+dx)/capacity` (Prime), flat floor (RWA) and amortizes entry fees over the holding horizon, so short horizons and whale sizes flip the winner where naive spot-APY routing would be wrong. See the live sliders in the UI. | `src/lib/router.ts` · `src/lib/adapters/projection.ts` |
| 2 | **Cryptographic quote-to-payload commitment** — `keccak256(abi.encode(user, vault, action, amount, netApy, runnerUpHashes[], chainId, calldata))` binds the unsigned payload to the exact multi-venue comparison table; anchored on-chain via `AggregatorRouteAnchor`. | `src/lib/commitment.ts` · `src/lib/payload.ts` · on-chain anchor |
| 3 | **Multi-vault split-withdrawal solver** — drains the lowest net-APY position first, splits across venues under balance/liquidity caps (`[Harbor 499, Prime 301]` for an 800 request), reports exact shortfalls instead of faking success. | `src/lib/router.ts` |
| 4 | **Per-protocol circuit breaker with half-open probes** — deterministic health states on every receipt (`venueHealthSnapshot`), zero wasted RPC while open, automatic re-close on probe success; UI chaos toggle + live on-chain pause drill. | `src/lib/resilience.ts` · `src/lib/chaos.ts` |

## Quick start

```bash
npm install
npm run compile          # solc -> src/generated/suite.json
npm run deploy           # deploy + seed PharosVaultSuite (writes PHAROS_* env)
npm test                 # 311 vitest tests
npm run verify           # 4-scenario live on-chain proof -> evidence/ + receipts
npm run dev              # http://localhost:3000 (dark Harbor console)
npm run build            # production build
npm run audit:secrets    # strict secret audit
```

## UI (reviewer-first)

- **Unified Portfolio + 3-Vault Rate Matrix** — live APY, fees, TVL, idle liquidity, utilization, health badges.
- **NL command bar + presets** — the exact commands from the rubric, one click each.
- **Horizon & amount sliders** — real-time venue switching using the same pure routing math as the server
  (watch Prime → RWA flip between a 10k and 20k deposit, or Prime lose its crown at a 7-day horizon).
- **"Why This Venue Won" card** — winner + runner-up rejection table with dollar math.
- **Protocol chaos toggles** — kill any protocol; the other two keep serving (degraded banner appears).
- **Unsigned payload inspector + wallet sign** — per-leg JSON, copy for external wallets, or sign with an
  injected wallet on Atlantic (the *user's* wallet is the only signer).

## Testing

**311 tests / 15 files, all green** — routing math narratives (horizon flips, whale crossovers), withdrawal
opportunity-cost + split solver, circuit-breaker state machine, allSettled fault isolation (1–3 venues down),
NL/structured parsing, keccak commitment tamper-evidence, ABI encoding fidelity, source-level airgap scan,
and solc-artifact consistency. Run with `npx vitest run`.

## Clearly Stated Limits & Architectural Boundaries

- **Pharos Atlantic RPC `eth_call` fresh-state / quota note.** The public endpoint is ZAN-backed and
  rate-limited (`cu limit exceeded; Request too fast per second`). All reads run through a serialized
  ~6 req/s client with exponential-backoff retries (`src/lib/rpc.ts`). Under bursts a venue may be
  classified `DEGRADED_TIMEOUT`/`CIRCUIT_OPEN` — that is the fault-isolation layer working as designed;
  the half-open probe restores it automatically. Prefer the paced `npm run verify` over parallel dev tabs.
- **Underlying asset** is a suite-owned 6-decimal test token so the demo is self-contained; the official
  Atlantic USDC address is tracked in env and the vault math is asset-agnostic.
- **Simulated borrower demand** (Harbor) and a **demo time machine** (`warpAccrual`) exist so utilization
  dynamics and 30-day yields are visible in a minutes-long testnet review; both are deployer-gated.
- **Gas modelling** uses a fixed per-action USD cost (identical across venues — never distorts ranking).
- **No price oracle needed** — values are native to the underlying; the only USD conversion is gas.
- **Admin controls** (pause/warp/borrow) are deployer-gated for the arena; production would route them
  through governance/timelocks.
- **wagmi** uses the injected connector only (no WalletConnect projectId committed); payloads are
  executable by any external wallet via "Copy JSON".

## Evidence

- `evidence/deployment.json` — deterministic deploy record (addresses + tx).
- `evidence/aggregator-evidence.json` — machine-readable 4-scenario verification (snapshots, verbatim
  rationales, comparison tables, health snapshots, all tx hashes).
- [SUBMISSION_EVIDENCE.md](SUBMISSION_EVIDENCE.md) — reviewer transcript with clickable PharosScan links.
- Secrets: `.env.local` is git-ignored; `npm run audit:secrets` proves zero key material in tracked files.
