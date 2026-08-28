<div align="center">
  <img src="site/assets/vinpassport-banner.png" alt="VINPassport, proving a vehicle identity" width="700"/>
  <p><strong>A Digital Circularity Vehicle Passport built on Midnight's zero-knowledge blockchain.</strong></p>
  <p>Prove what a vehicle is. Reveal only what the asker is entitled to see.</p>
  <p>
    <a href="https://passport.vin/"><b>Website (Live Demo)</b></a> ·
    <a href="https://passport.vin/deck/"><b>Slide deck</b></a>
  </p>
</div>

---

> **Status: pre-alpha, under active development.** The Compact contract is written, compiles and is
> covered by tests, and the three application surfaces (verification, intake console, proof
> explorer) run against the compiled circuits with one command (`npm run app`). Not yet done:
> the contract is not deployed to preprod, and the live pages read demo state rather than chain
> state. The table under [Where this actually stands](#where-this-actually-stands) says exactly
> what does and does not exist today.

## Contents

- [The problem](#the-problem) · [What VINPassport does](#what-vinpassport-does)
- [Quick start](#quick-start) · [Evaluating this repository](#evaluating-this-repository)
- [The contract](#the-contract) · [How privacy is achieved](#how-privacy-is-achieved)
- [Where this actually stands](#where-this-actually-stands) · [Repository map](#repository-map)
- [Built on](#built-on) · [Documentation](#documentation)

## The problem

From **1 September 2032**, every vehicle placed on the EU market must carry a **Digital Circularity
Vehicle Passport** under [Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj),
which entered into force on 13 August 2026. The regulation requires that passport to be *"aligned,
interoperable and, where possible, integrated with other vehicle related environmental passports
established under Union law"*: most obviously the EV battery passport that becomes mandatory in
February 2027 under [Regulation (EU) 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj).

That mandate creates a conflict. A vehicle passport has to be **verifiable by strangers**: a buyer,
a recycler, a border authority, and simultaneously **confidential**, because a full vehicle history
is commercially sensitive to a dealer and personally identifying to an owner. Publishing the record
solves the first and destroys the second. Keeping it private solves the second and leaves the first
where it is today: trust the seller.

The reason it is worth solving privately is everything downstream of it: title washing,
undisclosed accident history, fabricated service records, mileage fraud, and the ordinary asymmetry
where a used-car buyer has no way to check what they are told.

## What VINPassport does

One canonical vehicle record, anchored once on Midnight. From then on, each party is shown exactly
what they are entitled to and provably nothing more.

The contract in this repository holds a commitment **per field**, each under an integrity rule
fixed when the field is created:

| The question | What the chain learns |
|---|---|
| Register this vehicle's passport | A VIN hash, a content root, and who vouched for it |
| Has it ever been written off? | **No** or the transaction fails |
| Has it ever had a reported accident? | **No** or the transaction fails |
| Record a service, an inspection, a reading | That the field moved **only the way that field may move** |
| Is the mileage under 150,000 km? | **Yes** or the transaction fails |

Every field is held the same way, and each declares its own integrity rule when it is created.
Mileage, accidents, keepers, services and write-off category may never fall. The opposite direction
exists too: a rule that could only ever point one way would not be a rule at all, and nothing would
be fixed at creation.

At no point does a field value itself reach the ledger. Neither does the salt that hides it.
The chain stores a commitment; the claims are proven against that commitment inside a ZK circuit.
That is [tested directly](#how-privacy-is-achieved), not asserted.

### Nobody touches a wallet

A buyer scans a QR code and sees a verdict, *never written off · no reported accidents · one
keeper*, with no app, no account, and no login. A dealer signs in with an email and a password. Neither ever holds a key, a
token, or any cryptocurrency.

Every transaction fee is sponsored. Every customer payment is ordinary fiat: card, direct debit or
invoice. The blockchain is an implementation detail, and it is meant to stay one. See
[BUILD-SCOPE.md](docs/BUILD-SCOPE.md).

## Quick start

Requires **Node.js 22+**. Nothing else: no Docker, no wallet, no network access, no API keys.

```bash
git clone https://github.com/VINPassport/VINPassport
cd vinpassport
npm install
npm test
```

Expected: **67 contract tests, 10 app tests and 24 SDK assertions, all passing**, in a couple of
seconds.

```
 Test Files  1 passed (1)
      Tests  67 passed (67)

# pass 10

================ 24 passed, 0 failed ================
```

| Command | What it does |
|---|---|
| `npm test` | Everything below, in one run |
| `npm run test:contract` | The 67 contract tests, against the compiled circuits |
| `npm run test:watch` | The same, re-running on change |
| `npm run test:app` | 10 tests on the scan page's verdict logic, via `node --test` |
| `npm run test:sdk` | 24 assertions pinning our assumptions about `@odatano/dpp-sdk` |
| `npm run app` | All three surfaces + the circuits, one dependency-free server |
| `npm run serve:scan` | The verification page alone, statically |
| `npm run demo:export` | Regenerate the scan page's demo ledger by running the compiled circuits |
| `npm run deploy:preprod` | Build + prove the deploy locally; `--submit` hands it to the sponsor |
| `npm run compile` | Recompile the Compact contract: **WSL2, macOS or Linux only**, see below |

### The app: three surfaces, one command

```bash
npm run app        # -> http://localhost:8790
```

| Surface | | Who it is for |
|---|---|---|
| **Verification** | `/` | A buyer: scan a QR, see what the passport has *proven* and what it has not |
| **Intake console** | `/console/` | A registrar: fill in the fields, submit, watch the circuits accept and refuse |
| **Proof explorer** | `/proofs/` | An auditor: every claim on the ledger, marked current or superseded |

The server is dependency-free Node and runs the **real compiled circuits in-process**: submitting
the console form registers the passport, records the history, and proves the claims. A rollback
update or an unsupportable claim is refused in-circuit, shown as refused, and writes nothing. The
same three surfaces are live statically at **<https://passport.vin/>**, where the
console falls back to producing an intake file for `scripts/intake.mjs`.

All three are plain HTML/CSS/JS with no build step, by decision
([D11](docs/DECISIONS.md#settled)): the audience is a used-car buyer holding a phone.

Its demo ledger is **not hand-written**: `scripts/export-demo-state.mjs` runs the real compiled
circuits through a scripted history and exports the resulting public ledger, asserted clean of
every private value. Two vehicles on purpose: one that proved the four buyer questions, and one
whose clean-history proofs would abort in-circuit, so the page must render *not proven* honestly
rather than inferring a "no".

### Recompiling the contract

The compiled output is committed, so the tests and this repository can be evaluated with no Compact
toolchain at all. To rebuild it yourself you need
[Compact CLI 0.5.2 with compiler 0.31.1](https://docs.midnight.network/):

```bash
npm run compile
```

**Compact has no native Windows binary, and on Windows `compact` resolves to the built-in NTFS
compression utility instead**: a silent failure that looks like success. Compile in WSL2, macOS or
Linux. See [`contracts/README.md`](contracts/README.md).

## Evaluating this repository

If you are reviewing this (for the Midnight Buildathon or otherwise) this is the shortest path to
seeing whether the claims hold.

**1. The contract compiles.** The committed build carries its own provenance:

```bash
cat contracts/vinpassport/src/managed/vinpassport/compiler/contract-info.json
```

> `"compiler-version": "0.31.1"`, `"language-version": "0.23.0"`, `"runtime-version": "0.16.0"`,
> the stable ledger-8 line. Five circuits, all with `"proof": true`.

**2. The tests exercise the real circuits.** `test/passport-simulator.mjs` loads the *compiled*
contract and runs it through `@midnight-ntwrk/compact-runtime` at the pinned matching version
(`0.16.0`). An assertion that fires in these tests is the same assertion that would reject the
transaction on chain.

**3. The tests would catch a regression.** Passing tests prove nothing on their own, so both
integrity rules were checked by mutation. Deleting either guard from `recordField` and recompiling
fails exactly the tests that guard exists for, and nothing else:

| Line deleted | Tests that fail |
|---|---|
| `assert(rule != Rule.neverFalls \|\| current >= prev, "value decreased");` | **7**: odometer rollback, erasing an accident, clearing a write-off, reducing keepers |
| `assert(rule != Rule.neverRises \|\| current <= prev, "value increased");` | **3**: a declining field climbing back up |

You can reproduce either; both are one-line edits to
[`vinpassport.compact`](contracts/vinpassport/src/vinpassport.compact).

**4. Read the contract itself.** It is commented for a reader who does not know Compact: [`contracts/vinpassport/src/vinpassport.compact`](contracts/vinpassport/src/vinpassport.compact).

**5. The honest limits are written down, not buried.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
§ *The trust gap* states plainly what this does not prove. See [below](#what-this-does-not-prove).

## The contract

[`contracts/vinpassport`](contracts/vinpassport). VINPassport's own Compact contract.

### Public ledger

| Ledger field | Type | Holds |
|---|---|---|
| `passports` | `Map<Bytes<32>, Bytes<32>>` | VIN hash → content root of the canonical record |
| `registrar` | `Map<Bytes<32>, Bytes<32>>` | VIN hash → registering authority, so a claim is attributable |
| `fieldCommitment` | `Map<Bytes<32>, Bytes<32>>` | slot → commitment to that field's current value |
| `fieldRule` | `Map<Bytes<32>, Rule>` | slot → the integrity rule, written once at creation |
| `claims` | `Map<Bytes<32>, Claim>` | claim key → a proof that was made, and the value version it was made about |
| `updateCount` | `Counter` | How many field updates exist across all vehicles |

A **`Claim`** records what was proven and never the value that satisfied it: the slot, the VIN hash,
the field key, the bound, the direction, and **the commitment the proof opened**. That last part is
what stops a claim outliving the value it was made about: record a new reading and the old claim
no longer matches the current `fieldCommitment` for that slot, so a verifier can see it is
superseded without being told. See [D19](docs/DECISIONS.md#settled).

A **slot** is `persistentHash(["vinpassport:field:v1", vinHash, fieldKey])`: domain-separated, so a
slot key cannot collide with any other hash the contract stores, and an observer who does not
already know both the vehicle and the field cannot tell which slot holds what.

### Private state

Four witnesses, none of which ever reach the ledger:

| Witness | Type | Why it is private |
|---|---|---|
| `newValue` | `Uint<64>` | The value being written |
| `previousValue` | `Uint<64>` | The current value, needed to open the stored commitment |
| `previousSalt` | `Bytes<32>` | The opening for that commitment |
| `newSalt` | `Bytes<32>` | A fresh opening, so equal values do not produce equal commitments |

### Circuits

| Circuit | Public arguments | Proves |
|---|---|---|
| `registerPassport` | VIN hash, content root, registrar id | This vehicle is registered once, by a named registrar |
| `initialiseField` | VIN hash, field key, rule | A field exists under a rule fixed for good: without publishing its value |
| `recordField` | VIN hash, field key | The caller **knows the current value**, and the change **respects the field's rule** |
| `proveFieldAtMost` | VIN hash, field key, bound | The hidden value is **at or below a public bound** |
| `proveFieldAtLeast` | VIN hash, field key, bound | The hidden value is **at or above a public bound** |

Both proof circuits **record the claim** on success. A circuit that only asserted would leave a
verifier nothing to read: the transaction succeeding *is* the proof, but nothing would index it by
vehicle, so a scan-to-verdict page would have no state to query. A failed proof aborts before the
write, so the claims ledger only ever holds claims that held.

The rule lives on the ledger rather than in the call, so a caller cannot pick the flattering rule at
the moment they need it. Recreating a field to change its rule is refused.

Threshold proofs carry the claims a buyer actually asks for: *"never written off"* is
`proveFieldAtMost(writeOffCategory, 0)`, *"never had a reported accident"* is
`proveFieldAtMost(accidentCount, 0)`, and *"one owner from new"* is
`proveFieldAtMost(ownerCount, 1)`. `proveFieldAtLeast` is the mirror, for a floor rather than a
ceiling.

## How privacy is achieved

`recordField` is the interesting one, so it is worth stating what it actually does.

The ledger holds `persistentCommit(value, salt)`, never the value. To write a new one the caller
must, **inside the circuit**:

1. supply the current value and its salt as witnesses;
2. recompute the commitment and prove it equals what the ledger already stores, which is only
   possible if they genuinely know the current value;
3. read the field's rule **from the ledger** and prove the new value respects it;
4. replace the commitment with one over the new value and a fresh salt.

Both values are witnesses throughout. The chain records **that an integrity check passed**, without
recording **what passed it**. `proveFieldAtMost` and `proveFieldAtLeast` do the same against a
public bound, so a dealer can answer *"never written off?"* or *"under 150,000 km?"* with a proof
rather than a promise.

A recorded claim **names the field it is about**, which the slot hash alone would not reveal. That
is deliberate: a verdict a verifier cannot read is not a verdict, and the VIN hash is already public
because `passports` is keyed by it. Fields nobody has claimed about stay unnamed, and **the value
stays private in every case**: two adjacent tests pin both halves rather than leaving it to this
paragraph.

This is tested rather than claimed. `test/passport.test.mjs` includes a group named
*what the public ledger never learns*, which walks every value on the ledger after a full service
history and asserts no reading and no salt appears among them, plus a test that the search **would**
find a value that is there, so the privacy assertions cannot pass vacuously.

The suite also covers the attacks worth naming:

- a rollback by one kilometre, not just an obvious one;
- a caller who knows the reading but not the salt, and vice versa;
- a rollback dressed up with a matching false opening;
- a threshold proof that tries to claim a flattering value it cannot open to.

### What this does not prove

It proves a reading is **the one that was committed**, and that it satisfies a bound. It does not
prove the reading matches physical reality. A producer who commits a false value produces a
cryptographically valid proof of a false fact.

Closing that gap needs hardware attestation at the source, which is deliberately scoped as **Phase
2** rather than pretended away. This is the honest limit of the current design and it is stated in
full in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Where this actually stands

| Component | Status |
|---|---|
| Compact contract: 5 circuits | **Done.** Compiles clean, artifacts committed and reproducible from source |
| Contract test suite | **Done.** 67 tests; integrity rules and the claim write both mutation-checked |
| SDK assumption guard | **Done.** 24 assertions against `@odatano/dpp-sdk` 0.2.0 |
| Provable-field registry, 32 slots | **Settled** ([FIELDS.md](docs/FIELDS.md)). 26 in use, reserve 17–21 and 31; not yet wired |
| Deployment to Midnight preprod | **Not yet.** Path settled: `@odatano/nightgate-tx` with sponsored fees, see [D20](docs/DECISIONS.md#settled) |
| Frontend: verification, intake console, proof explorer | **Done.** Three surfaces against the compiled circuits (`npm run app`); the live pages read demo state until the preprod deploy |
| CAP service layer, tier redaction | **Not in this submission.** Wave 2: see [D20](docs/DECISIONS.md#settled) |

## Repository map

```
contracts/vinpassport/
  src/vinpassport.compact     the contract: start here
  src/managed/                       compiled output, committed on purpose
docs/                                design, decisions, regulatory basis
test/
  passport-simulator.mjs             harness: compiled circuits + a local ledger
  passport.test.mjs                  67 contract tests
  sdk-assumptions.mjs                24 assertions pinning @odatano/dpp-sdk behaviour
```

## Built on

| | |
|---|---|
| [Midnight Network](https://midnight.network) | Zero-knowledge blockchain; ledger 8, Compact 0.31.1 |
| [`@odatano/dpp-sdk`](https://github.com/ODATANO) | Salted-Merkle field panel: key derivation, value scaling, tree construction |
| [`@odatano/nightgate-tx`](https://github.com/ODATANO/NIGHTGATE) | Local transaction building and proving; sponsored submission |

**Where the line falls.** VINPassport's Compact contract is its own work: five circuits, its own
ledger, its own integrity rules. It is not a fork, and it does not extend NIGHTGATE's
`attestation-vault`. The 32-slot field panel is ours too: the slot layout is a vehicle-domain
design, built on `@odatano/dpp-sdk` for key derivation, value scaling and Merkle construction.

VINPassport builds on ODATANO in three ways. The field panel uses `@odatano/dpp-sdk`.
`@odatano/nightgate-tx` builds and proves transactions locally against our own key. And ODATANO's
hosted NIGHTGATE sponsors our preprod transaction fees under a metered grant: every transaction
is built, proven and signed on our side; **NIGHTGATE pays and submits, and never sees a witness.**

VINPassport does not use NIGHTGATE's CAP service, its OData layer, its `attestation-vault` contract,
or its disclosure grants. Those are on the roadmap, not in this submission, see
[D20](docs/DECISIONS.md#settled).

Thanks to **[ODATANO](https://github.com/ODATANO)** for the SDK, for the sponsoring grant, for
review, and for the [reference integration](https://github.com/maxalexweber1/VINPassport-NIGHTGATE-DEMO)
that implements this panel end-to-end on Midnight preprod.

## Documentation

| Document | What it covers |
|---|---|
| [DEMO.md](docs/DEMO.md) | The ninety-second walkthrough: doubles as the video script |
| [deck/](deck/index.html) | The Wave 1 slide deck: [present it live](https://passport.vin/deck/), arrow keys to advance, Ctrl+P for the PDF |
| [REGULATION.md](docs/REGULATION.md) | Primary legal sources, with direct EUR-Lex links |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, the trust model, and its honest limits |
| [BUILD-SCOPE.md](docs/BUILD-SCOPE.md) | Structure, stack, sponsoring and billing models |
| [DECISIONS.md](docs/DECISIONS.md) | Settled decisions and the reasoning behind them |
| [FIELDS.md](docs/FIELDS.md) | The 32-slot provable-field registry and its capacity limits |
| [ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan |
| [contracts/README.md](contracts/README.md) | Building the contract, and the private-state model |

**New here?** Start with [REGULATION.md](docs/REGULATION.md): the regulation is *why* this project
exists, and the full text is one click away.

## Licence

Apache-2.0, matching the ODATANO stack. See [LICENSE](LICENSE).

---

<div align="center">
  Rebuilt August 2026 · <a href="https://midnight.network">Midnight Network</a> · <a href="https://github.com/ODATANO">ODATANO</a>
</div>
