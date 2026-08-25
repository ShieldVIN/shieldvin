<div align="center">
  <img src="https://raw.githubusercontent.com/ShieldVIN/.github/main/profile/shieldvin-banner.png" alt="ShieldVIN — Proving a Vehicle History" width="700"/>
  <p><strong>A Digital Circularity Vehicle Passport built on Midnight's zero-knowledge blockchain.</strong></p>
  <p>Prove what a vehicle is. Reveal only what the asker is entitled to see.</p>
</div>

---

> **Status: pre-alpha, under active development.** The Compact contract is written, compiles and is
> covered by tests. The application layer around it is not built yet. The table under
> [Where this actually stands](#where-this-actually-stands) says exactly what does and does not
> exist today — please read it rather than inferring from the docs, which describe the design in
> full including parts still ahead of us.

## Contents

- [The problem](#the-problem) · [What ShieldVIN does](#what-shieldvin-does)
- [Quick start](#quick-start) · [Evaluating this repository](#evaluating-this-repository)
- [The contract](#the-contract) · [How privacy is achieved](#how-privacy-is-achieved)
- [Where this actually stands](#where-this-actually-stands) · [Repository map](#repository-map)
- [Built on](#built-on) · [Documentation](#documentation)

## The problem

From **1 September 2032**, every vehicle placed on the EU market must carry a **Digital Circularity
Vehicle Passport** under [Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj),
which entered into force on 13 August 2026. The regulation requires that passport to be *"aligned,
interoperable and, where possible, integrated with other vehicle related environmental passports
established under Union law"* — most obviously the EV battery passport that becomes mandatory in
February 2027 under [Regulation (EU) 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj).

That mandate creates a conflict. A vehicle passport has to be **verifiable by strangers** — a buyer,
a recycler, a border authority — and simultaneously **confidential**, because a full vehicle history
is commercially sensitive to a dealer and personally identifying to an owner. Publishing the record
solves the first and destroys the second. Keeping it private solves the second and leaves the first
where it is today: trust the seller.

The reason it is worth solving privately is everything downstream of it — odometer fraud, title
washing, undisclosed accident history, and the ordinary asymmetry where a used-car buyer has no way
to check what they are told.

## What ShieldVIN does

One canonical vehicle record, anchored once on Midnight. From then on, each party is shown exactly
what they are entitled to and provably nothing more.

The odometer is the sharpest case, and it is what the contract in this repository implements:

| The question | What the chain learns |
|---|---|
| Register this vehicle's passport | A VIN hash, a content root, and who vouched for it |
| Record a new odometer reading | That a reading was recorded, and that it was **not lower than the last one** |
| Is the odometer under 150,000 km? | **Yes** or the transaction fails |

At no point does the odometer reading itself reach the ledger. Neither does the salt that hides it.
The chain stores a commitment; the claims are proven against that commitment inside a ZK circuit.
That is [tested directly](#how-privacy-is-achieved), not asserted.

### Nobody touches a wallet

A buyer scans a QR code and sees a verdict — *odometer: never rolled back* — with no app, no
account, and no login. A dealer signs in with an email and a password. Neither ever holds a key, a
token, or any cryptocurrency.

Every transaction fee is sponsored. Every customer payment is ordinary fiat — card, direct debit or
invoice. The blockchain is an implementation detail, and it is meant to stay one. See
[BUILD-SCOPE.md](docs/BUILD-SCOPE.md).

## Quick start

Requires **Node.js 22+**. Nothing else — no Docker, no wallet, no network access, no API keys.

```bash
git clone https://github.com/ShieldVIN/shieldvin
cd shieldvin
npm install
npm test
```

Expected: **37 contract tests and 24 SDK assertions, all passing**, in about a second.

```
 Test Files  1 passed (1)
      Tests  37 passed (37)

================ 24 passed, 0 failed ================
```

| Command | What it does |
|---|---|
| `npm test` | Everything below, in one run |
| `npm run test:contract` | The 37 contract tests, against the compiled circuits |
| `npm run test:watch` | The same, re-running on change |
| `npm run test:sdk` | 24 assertions pinning our assumptions about `@odatano/dpp-sdk` |
| `npm run compile` | Recompile the Compact contract — **WSL2, macOS or Linux only**, see below |

### Recompiling the contract

The compiled output is committed, so the tests and this repository can be evaluated with no Compact
toolchain at all. To rebuild it yourself you need
[Compact CLI 0.5.2 with compiler 0.31.1](https://docs.midnight.network/):

```bash
npm run compile
```

**Compact has no native Windows binary, and on Windows `compact` resolves to the built-in NTFS
compression utility instead** — a silent failure that looks like success. Compile in WSL2, macOS or
Linux. See [`contracts/README.md`](contracts/README.md).

## Evaluating this repository

If you are reviewing this — for the Midnight Buildathon or otherwise — this is the shortest path to
seeing whether the claims hold.

**1. The contract compiles.** The committed build carries its own provenance:

```bash
cat contracts/shieldvin-passport/src/managed/shieldvin-passport/compiler/contract-info.json
```

> `"compiler-version": "0.31.1"`, `"language-version": "0.23.0"`, `"runtime-version": "0.16.0"` —
> the stable ledger-8 line. Four circuits, all with `"proof": true`.

**2. The tests exercise the real circuits.** `test/passport-simulator.mjs` loads the *compiled*
contract and runs it through `@midnight-ntwrk/compact-runtime` at the pinned matching version
(`0.16.0`). An assertion that fires in these tests is the same assertion that would reject the
transaction on chain.

**3. The tests would catch a regression.** Passing tests prove nothing on their own, so this was
checked by mutation: deleting the single line

```compact
assert(current >= prev, "odometer reading decreased");
```

and recompiling makes **exactly four tests fail** — the four anti-rollback tests — and nothing else.
You can reproduce that; it is a one-line edit to
[`shieldvin-passport.compact`](contracts/shieldvin-passport/src/shieldvin-passport.compact).

**4. Read the contract itself.** It is 104 lines and commented for a reader who does not know
Compact: [`contracts/shieldvin-passport/src/shieldvin-passport.compact`](contracts/shieldvin-passport/src/shieldvin-passport.compact).

**5. The honest limits are written down, not buried.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
§ *The trust gap* states plainly what this does not prove. See [below](#what-this-does-not-prove).

## The contract

[`contracts/shieldvin-passport`](contracts/shieldvin-passport) — ShieldVIN's own Compact contract.

### Public ledger

| Ledger field | Type | Holds |
|---|---|---|
| `passports` | `Map<Bytes<32>, Bytes<32>>` | VIN hash → content root of the canonical record |
| `odometerCommitment` | `Map<Bytes<32>, Bytes<32>>` | VIN hash → commitment to the latest reading |
| `registrar` | `Map<Bytes<32>, Bytes<32>>` | VIN hash → registering authority, so a claim is attributable |
| `readingCount` | `Counter` | How many readings exist across all vehicles |

### Private state

Four witnesses, none of which ever reach the ledger:

| Witness | Type | Why it is private |
|---|---|---|
| `newReading` | `Uint<64>` | The reading being recorded |
| `previousReading` | `Uint<64>` | The last reading, needed to open the stored commitment |
| `previousSalt` | `Bytes<32>` | The opening for that commitment |
| `newSalt` | `Bytes<32>` | A fresh opening, so equal readings do not produce equal commitments |

### Circuits

| Circuit | Public arguments | Proves |
|---|---|---|
| `registerPassport` | VIN hash, content root, registrar id | This vehicle is registered once, by a named registrar |
| `initialiseOdometer` | VIN hash | A first reading exists — without publishing it |
| `recordReading` | VIN hash | The caller **knows the previous reading**, and the new one is **not lower** |
| `proveOdometerBelow` | VIN hash, bound | The hidden reading is **at or below a public bound** |

## How privacy is achieved

`recordReading` is the interesting one, so it is worth stating what it actually does.

The ledger holds `persistentCommit(reading, salt)` — never the reading. To record a new one the
caller must, **inside the circuit**:

1. supply the previous reading and its salt as witnesses;
2. recompute the commitment and prove it equals what the ledger already stores — which is only
   possible if they genuinely know the previous reading;
3. prove the new reading is greater than or equal to it;
4. replace the commitment with one over the new reading and a fresh salt.

Both readings are witnesses throughout. The chain records **that a monotonicity check passed**,
without recording **what passed it**. `proveOdometerBelow` does the same against a public threshold,
so a dealer can answer *"under 150,000 km?"* with a proof rather than a promise.

This is tested rather than claimed. `test/passport.test.mjs` includes a group named
*what the public ledger never learns*, which walks every value on the ledger after a full service
history and asserts no reading and no salt appears among them — plus a test that the search **would**
find a value that is there, so the privacy assertions cannot pass vacuously.

The suite also covers the attacks worth naming:

- a rollback by one kilometre, not just an obvious one;
- a caller who knows the reading but not the salt, and vice versa;
- a rollback dressed up with a matching false opening;
- a threshold proof that tries to claim a flattering value it cannot open to.

### What this does not prove

It proves a reading is **the one that was committed**, and that it satisfies a bound. It does not
prove the reading matches physical reality — a producer who commits a false value produces a
cryptographically valid proof of a false fact.

Closing that gap needs hardware attestation at the source, which is deliberately scoped as **Phase
2** rather than pretended away. This is the honest limit of the current design and it is stated in
full in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Where this actually stands

| Component | Status |
|---|---|
| Compact contract — 4 circuits | **Done.** Compiles clean, artifacts committed |
| Contract test suite | **Done.** 37 tests, mutation-checked |
| SDK assumption guard | **Done.** 24 assertions against `@odatano/dpp-sdk` 0.2.0 |
| Provable-field registry — 32 slots | **Designed** ([FIELDS.md](docs/FIELDS.md)), not yet wired |
| Deployment to Midnight preprod | **Not yet.** See [DECISIONS.md](docs/DECISIONS.md) D16 |
| CAP service layer, tier redaction | **Not yet** |
| Frontend — scan-to-verdict, console | **Not yet** |

## Repository map

```
contracts/shieldvin-passport/
  src/shieldvin-passport.compact     the contract — start here
  src/managed/                       compiled output, committed on purpose
docs/                                design, decisions, regulatory basis
test/
  passport-simulator.mjs             harness: compiled circuits + a local ledger
  passport.test.mjs                  37 contract tests
  sdk-assumptions.mjs                24 assertions pinning @odatano/dpp-sdk behaviour
```

## Built on

| | |
|---|---|
| [Midnight Network](https://midnight.network) | Zero-knowledge blockchain; ledger 8, Compact 0.31.1 |
| [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE) | OData V4 gateway to Midnight — anchoring, ZK predicates, disclosure grants, fee sponsoring |
| [`@odatano/dpp-sdk`](https://github.com/ODATANO) | Salted-Merkle field registry primitives |
| [SAP CAP](https://cap.cloud.sap/) | Application framework — CDS domain model, OData services |

ShieldVIN is a **consumer application** of NIGHTGATE, in the same relation to it as
[NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) is for battery passports. We do not fork it. The
contract in this repository is our own, and is the part we are asking to be judged on; NIGHTGATE
supplies the chain integration around it.

Thanks to **[ODATANO](https://github.com/ODATANO)** for the stack, for review, and for the
[reference integration](https://github.com/maxalexweber1/ShieldVIN-NIGHTGATE-DEMO) that shows a
vehicle passport anchored end-to-end on Midnight preprod through NIGHTGATE.

## Documentation

| Document | What it covers |
|---|---|
| [REGULATION.md](docs/REGULATION.md) | Primary legal sources, with direct EUR-Lex links |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, the trust model, and its honest limits |
| [BUILD-SCOPE.md](docs/BUILD-SCOPE.md) | Structure, stack, sponsoring and billing models |
| [DECISIONS.md](docs/DECISIONS.md) | Settled decisions and the reasoning behind them |
| [FIELDS.md](docs/FIELDS.md) | The 32-slot provable-field registry and its capacity limits |
| [ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan |
| [contracts/README.md](contracts/README.md) | Building the contract, and the private-state model |

**New here?** Start with [REGULATION.md](docs/REGULATION.md) — the regulation is *why* this project
exists, and the full text is one click away.

## Licence

Apache-2.0, matching the ODATANO stack. See [LICENSE](LICENSE).

---

<div align="center">
  Rebuilt August 2026 · <a href="https://midnight.network">Midnight Network</a> · <a href="https://github.com/ODATANO">ODATANO</a>
</div>
