# Architecture

The legal basis for everything below is
**[Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj)**, Article 46 — see
[REGULATION.md](REGULATION.md) for primary sources and the scope boundaries that constrain what we
may claim.

## Shape

ShieldVIN is a **SAP CAP application** that installs `@odatano/nightgate` as a plugin. NIGHTGATE
supplies the chain integration; ShieldVIN supplies the vehicle domain and the user-facing surfaces.

```
┌─────────────────────────────────────────────────────────┐
│  ShieldVIN (this repo)                                  │
│                                                         │
│  db/passport-schema.cds   vehicle domain model          │
│  srv/passport-service.ts  tier redaction + query guard  │
│  srv/lib/vehicle-anchor   canonicalise → hash → anchor  │
│  app/                     producer cockpit, viewer      │
└────────────────────────┬────────────────────────────────┘
                         │ CAP plugin
┌────────────────────────▼────────────────────────────────┐
│  @odatano/nightgate                                     │
│  anchoring · ZK predicates · disclosure grants · jobs   │
│  attestation-vault (Compact, shipped precompiled)       │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Midnight — preprod (ledger 8)                          │
└─────────────────────────────────────────────────────────┘
```

We do **not** fork NIGHTGATE. Where a need is general rather than vehicle-specific, it goes upstream
as a request or a PR.

## What we get, and what we must build

NIGHTGATE ships the `attestation-vault` contract **precompiled**, so ShieldVIN needs no Compact
toolchain. This matters more than it sounds: Compact has no native Windows binary, so a toolchain
dependency would force every contributor into WSL2 on day one.

**Provided:** document anchoring, salted-Merkle field proofs, six predicate kinds, three-level
on-chain disclosure grants, async job orchestration, wallet and proving infrastructure, OData V4
query semantics over all of it, and transaction fee sponsoring.

**Ours to build:** the vehicle domain model, the provable-field registry, tier redaction rules and
their query guard, both UIs, document storage, the auth strategy, and all HTTP security middleware.
NIGHTGATE deliberately installs no global middleware — CORS, CSP and HSTS are the host's problem.

## Disclosure tiers

NIGHTGATE's three levels map onto vehicle stakeholders cleanly:

| Level | Tier | Audience | Sees |
|---|---|---|---|
| 0 | `public` | Buyer scanning a listing | Make, model, year, category, type approval, environmental declarations |
| 1 | `trade` | Dealer, recycler, insurer, lender | + odometer, accident count, owner count, service count, battery health |
| 2 | `authority` | DMV, police, notified body, ELV facility | + VIN, supplier identities, full lineage, dismantling data |

Two enforcement layers, and the second is not optional. Redaction after a database read is
**bypassable via `$filter`, `$orderby` and `$apply`** — an attacker who cannot *see* a column can
still binary-search its value by filtering on it. So the service must also reject queries that
*probe* an invisible column, not merely strip it from the response. NIGHTPASS learned this; we
inherit the lesson rather than rediscovering it.

On-chain grants can **elevate** a caller above their login role for a specific passport. Grantee
identities are `sha256(did)` — a pseudonym, never PII.

## Predicates worth demonstrating

| Claim | Mechanism | Why it lands |
|---|---|---|
| Odometer has never decreased | `documentComparison` across anchor versions | The fraud everyone recognises, proven without revealing a single reading |
| Never written off | `fieldPredicate` — `accidentCount ≤ 0` | A clean-history claim that discloses nothing about incidents |
| Recycled content meets threshold | `fieldPredicate` — `recycledPlasticPct ≥ N` | Compliance proof that does not leak supplier economics |
| Battery health above bound | `fieldPredicate` on slot 12 | The join to the battery passport |

The odometer case is the one to build first. It is the clearest possible demonstration that ZK is
doing real work: a monotonicity claim across an entire ownership chain, where every reading stays
hidden and the answer is still verifiable by anyone.

A false claim **aborts during local proving, before submission** — it never reaches the chain. A
successful transaction *is* the proof.

## The trust gap

**This is the most important section in this document, and the easiest to gloss over.**

NIGHTGATE's own architecture notes state the limit plainly: a fully trustless binding between the
anchored content root and the payload hash would need in-circuit blake2b, which is impractical. The
same attester builds both from the same content at anchor time.

So:

> **The producer is trusted to input truthful values.** A ZK proof shows a value is *the anchored
> one* and satisfies a bound. It shows nothing about whether that value matches physical reality.

For batteries this is tolerable — a manufacturer declaring its own carbon footprint is the assumed
model, and the regulation is built around accountable self-declaration.

**For odometer readings and VIN integrity it is the entire problem.** A garage that anchors a rolled-
back odometer produces proofs that are cryptographically perfect and factually false. Anchoring
makes the lie *immutable and attributable*; it does not make it detectable.

Three honest responses, and we intend all three:

1. **Attribute every anchor.** Tamper-evidence and a named attester is a real improvement on a paper
   service book, even without hardware. Fraud becomes traceable rather than deniable.
2. **Prove consistency, not truth.** Monotonicity across versions catches the common rollback case
   without any trust assumption, because it compares the producer's own prior commitments.
3. **Close the gap with hardware — Phase 2.** Sensor-signed readings from a tamper-resistant element
   at source are the only thing that binds a number to physical reality. This is where ShieldVIN's
   original three-chip work earns its place, and it is precisely the gap NIGHTGATE documents and
   does not attempt to fill.

Nothing in Phase 0 or Phase 1 should be described as preventing odometer fraud. It makes fraud
attributable and rollbacks detectable. That is a real claim; the stronger one would be false.

## Hard constraints

| Constraint | Consequence |
|---|---|
| **No in-circuit signature verification on mainnet.** Compact 0.31.x / ledger 8 has none. `jubjubSchnorrVerify` exists only on the ledger-9 RC line (0.33+), undocumented and deployed nowhere public. | Phase 2 sensor signatures cannot be verified in-circuit today. Spec the hardware **curve-agile** — Ed25519 is *not* a safe default; Schnorr-over-Jubjub is the likely landing point. |
| **NIGHTGATE hard-gates mainnet off** (`allowMainnetSubmission: false`). | Preprod is the target. Plan no mainnet demo. |
| **32 provable slots** via `attestation-vault-32` (NIGHTGATE 0.19.0). Width is effectively permanent — cross-root proofs relate same-width documents only. | 26 in use, 6 reserved. See [FIELDS.md](FIELDS.md). No longer the binding constraint, but the width choice is one-way. |
| **Sponsor throughput scales with wallet count**, not balance — one dust spend in flight per wallet. | Treasury is a pool. See [BUILD-SCOPE.md](BUILD-SCOPE.md). |
| **`setNetworkId()` is process-global.** | One network per process. No multi-network single deployment. |
| **NIGHTGATE is 0.x, shipping breaking changes roughly weekly.** A whole attestation lane was removed at 0.16.0; salting at 0.16.0 broke every older client. | **Pin exact versions.** Never use `^` on `@odatano/*`. Upgrade deliberately, with a re-anchor plan. |
| **Bus factor of one** across the entire ODATANO org. | Apache-2.0 makes a fork legally trivial. Keep a vendored copy of the exact version in use, and do not accrete dependencies on unreleased behaviour. |
| **Losing `contentSaltSeed` makes an anchored root permanently unprovable.** | Seed backup is an operational requirement with a tested restore path, not a nicety. |

## Verification status

This document is derived from reading public ODATANO repositories and Midnight release notes. It has
**not** been validated by running the stack. Before building on any specific claim here, confirm it
against the installed packages — the checklist in [FIELDS.md](FIELDS.md) is the starting point.
