# Build scope

What we are building, what we are building it with, and the order it happens in.

Structure follows [NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) — the reference consumer
application on NIGHTGATE — because matching a working pattern beats inventing one.

---

## Three product constraints

Everything below is downstream of these. They are settled; see
[DECISIONS.md](DECISIONS.md) D11–D14.

1. **Simple enough for anyone.** No user of any kind ever sees a wallet, a key, or the word
   "blockchain" unless they go looking for it.
2. **Every transaction is sponsored from a ShieldVIN treasury.** Customers never hold DUST or NIGHT.
3. **Every payment is fiat.** One-off, subscription or annual. No crypto payment path exists.

---

## The flow that has to be effortless

A buyer standing in a forecourt with a phone:

**Scan a QR code → see a verdict.** No login, no app, no wallet, no explanation of zero-knowledge
proofs. A page that says *Odometer: never rolled back ✓* — and, if they tap, *how do you know that?*

Three rules follow, and they bind every consumer-facing surface:

- **Verdicts, not data.** Three or four plain-language ticks. Detail lives behind a tap.
- **Never say "zero-knowledge proof" on a consumer surface.** Say *"verified without revealing the
  reading."*
- **No account required to read.** Reading a passport is public. Writing one is not.

---

## Sponsoring model

Three custody models were considered. The distinction is not cosmetic — it decides who the record
says asserted a fact.

| | Who signs | Attribution lands on | Verdict |
|---|---|---|---|
| A | ShieldVIN | ShieldVIN | **Rejected** |
| B | ShieldVIN, per-org | The organisation | **Chosen** |
| C | The organisation, locally | The organisation | Supported later |

**Why A is rejected.** If ShieldVIN signs everything, ShieldVIN asserts everything. A dealer supplies
a false odometer reading and the record says *we* claimed it. That transfers liability for data we
cannot verify onto the party least able to verify it, and it destroys the traceability that Phases
0–1 exist to provide.

**Model B, as built.** ShieldVIN custodies one wallet session per organisation. A treasury **pool**
pays every fee via NIGHTGATE's `sponsorSessionId`. The dealer authenticates with an email and a
password, and their name lands on the record.

### The treasury is a pool, not a wallet

Since NIGHTGATE 0.17.2, `NIGHTGATE_FEE_SPONSOR_SESSION` is a **lease pool** of sponsor sessions, and
the reason matters:

> A dust wallet carries ONE spend in flight (concurrent balances race its notes into `1010`
> rejects), so sponsoring throughput scales with the NUMBER of sponsor wallets.

Each sponsored job leases one wallet for its duration; callers queue on the pool
(`NIGHTGATE_SPONSOR_LEASE_WAIT_MS`, default 120s); a sponsor failing retryably is benched
(`NIGHTGATE_SPONSOR_COOLDOWN_MS`) while the job tries the next. Omitting `sponsorSessionId` — or
passing the reserved pool sentinel — uses the pool. Pinning an explicit session is a security
boundary and stays exact.

**Consequence for capacity planning:** peak concurrent anchoring is bounded by the number of sponsor
wallets, each needing its own registered NIGHT UTxO for dust generation. Treasury sizing is a count
of wallets, not a balance.

### Batching is the primary cost lever

NIGHTGATE 0.19.0's txbuilder takes `buildSponsorable({ calls: [...] })` — up to **8 circuit calls in
one transaction, one fee, one sponsoring**, with a pre-proving causality check so a violating batch
fails locally and spends nothing.

Because we pay every fee, this is not a performance optimisation but a unit-economics one. Any
operation issuing multiple claims should batch. Measure batched versus unbatched cost as part of
Phase 0.

**Built to accept Model C.** `srv/lib/sponsor.ts` puts the signing source behind an interface with
two implementations: custodial now, external signer later. The treasury pays either way. An
enterprise customer that wants self-custody uses
[`@odatano/nightgate-tx`](https://github.com/ODATANO/NIGHTGATE) — they build, prove and sign locally
and hand us a fee-unpaid transaction; we never see a key or a witness.

### What custodial signing does and does not prove

Stated plainly, because overclaiming here would be dishonest:

> Custodial attestation is **tamper-evident and attributable**. It is **not non-repudiable**.

A custodial signature proves ShieldVIN's infrastructure produced the record on an organisation's
behalf. It does not cryptographically prove that organisation intended it. Every attestation is
therefore paired with an **authenticated intent record** — who authenticated, when, from where, and
what they submitted. That is ordinary business evidence, not cryptographic proof, and it is
sufficient for commerce but not for a contested legal claim. Model C closes the gap for customers
who need it.

### Security requirements this creates

The wallets hold no funds — only the authority to attest, plus fees we supply. So this is not
financial custody. The real exposure is that a compromised key store would let false attestations be
written under a real organisation's name. That is harm to *our customer* caused by *our* breach, and
it is engineered against directly:

- Encryption key in a managed KMS, never an environment variable
- Per-organisation rate limits — we pay for every transaction, so an unmetered API is a cash leak
  as well as an abuse vector
- Volume anomaly alerting per organisation
- Full audit trail of authenticated intent

---

## Billing model

**Deferred — no billing in Phase 0.** The entitlement layer is designed so a provider drops in
later; nothing is integrated until unit costs are known.

**The principle: billing gates the action, not the chain.** Entitlement is checked in `srv/` before
NIGHTGATE is called. The contract never learns that an invoice exists. A pricing change never touches
crypto code.

**The dependency that decides pricing.** Plans cannot be priced until DUST cost per anchor and per
proof is measured. If an anchor costs more than a transfer fee nets, the model inverts. **Measuring
this is a Phase 0 task**, not a later one.

**Provider choice is open** and turns on EU VAT rather than features — a merchant-of-record provider
assumes VAT registration and remittance across member states, while a direct processor leaves that
obligation with us. Decide when billing is actually built.

---

## Repository structure

```
db/
  vehicle-schema.cds          vehicles, anchors, grants, attributes
  demo-schema.cds             seeded demo vehicles

srv/
  passport-service.{cds,ts}   read side — tier redaction + query guard
  producer-service.{cds,ts}   write side — create, anchor, prove
  demo-service.{cds,ts}       scripted scenarios
  lib/
    fields.ts                 the 32-slot provable registry (26 used, 6 reserved)
    vehicle-payload.ts        canonicalisation
    vehicle-anchor.ts         Merkle tree + anchoring
    tier.ts                   redaction rules
    query-guard.ts            reject $filter/$orderby probes of hidden columns
    sponsor.ts                treasury + per-org wallets, signing behind an interface
    chain-verify.ts           crawler-free verification
    entitlement.ts            plan checks (no provider yet)
  auth.ts   http-security.ts   server.ts

app/
  scan/        public QR landing — mobile-first
  explorer/    public verification
  console/     operator console

docs/          this directory
scripts/       seed, measure-dust-cost, treasury-topup
deploy/        docker-compose, Caddyfile
test/          unit, integration, ui-smoke
```

`query-guard.ts` is not optional. Redaction after a database read is bypassable — a caller who
cannot see a column can still binary-search its value by filtering on it. NIGHTPASS ships the same
module for the same reason.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node ≥22, TypeScript | Required by NIGHTGATE |
| Framework | `@sap/cds` ^10 | NIGHTGATE is a CAP plugin |
| Chain | `@odatano/nightgate` **0.19.0**, exact | 0.x with frequent breaking changes |
| DPP core | `@odatano/dpp-sdk` **0.2.0**, exact | Width-aware Merkle helpers |
| Local signing | `@odatano/nightgate-tx` **0.3.0**, exact | For the Model C path and batches |
| Vault | `attestation-vault-32` — 32 slots, depth 5 | See [FIELDS.md](FIELDS.md) |
| Database | SQLite (dev) → Postgres (prod) | NIGHTPASS's pattern |
| Unit tests | `node --test` + `tsx` | Matches ODATANO — deliberately not vitest |
| E2E | Playwright | Matches ODATANO |
| All UI | Plain HTML / CSS / JS | See below |
| Network | Preprod | Mainnet submission is gated off in NIGHTGATE |

**On UI:** NIGHTPASS uses SAPUI5 for operator apps and plain HTML for public ones. We use plain HTML
throughout, including the console. The product constraint is that this be simple enough for anyone,
and a framework that reads as enterprise software works against that — including for the small
independent dealer who is our beachhead.

**On version pinning:** ODATANO uses caret ranges on their own packages. We pin exact. Different risk
position when you are not the author.

---

## Phase 0

Ordered by dependency.

1. **Verify the [FIELDS.md](FIELDS.md) checklist** against installed packages — gates everything else
2. Scaffold CAP + NIGHTGATE 0.19.0, config modelled on NIGHTPASS's `cds.requires` block, registering
   `attestation-vault-32`
3. `npx nightgate-fetch-keys attestation-vault-32` — 32-slot prover keys are not packed in npm and
   are part of the artifact generation digest
4. `vehicle-schema.cds` + the 32-slot registry
5. Canonicalisation → anchor, one vehicle, end to end on preprod
6. **Treasury pool and sponsor wiring** — at least two sponsor wallets, each with a registered NIGHT
   UTxO, to exercise the lease pool rather than a single-wallet happy path. Confirm attribution lands
   on the organisation, not on us
7. **Measure DUST cost** per anchor and per proof, **batched versus unbatched**, and at width 32
   versus 16 — gates all pricing
8. Odometer monotonicity proof, end to end
9. `app/scan` — QR to verdict, mobile, no login
10. Seed data and a demo scenario

**Not in Phase 0:** billing, hardware, tiered disclosure UI, the console beyond a rough form.

Sponsoring and cost measurement come **before** any polished UI. If the unit economics do not work,
the UI is wasted effort — better learned in week one than week six.
