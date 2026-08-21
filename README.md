<div align="center">
  <img src="https://raw.githubusercontent.com/ShieldVIN/.github/main/profile/shieldvin-banner.png" alt="ShieldVIN — Proving a Vehicle History" width="700"/>
  <p><strong>A Digital Circularity Vehicle Passport built on Midnight's zero-knowledge blockchain.</strong></p>
  <p>Prove what a vehicle is. Reveal only what the asker is entitled to see.</p>
</div>

---

> **Status: pre-alpha.** Nothing here is production software. This repository is being rebuilt from
> scratch as of August 2026 on top of [ODATANO/NIGHTGATE](https://github.com/ODATANO/NIGHTGATE).
> Read [`docs/DECISIONS.md`](docs/DECISIONS.md) before contributing — several architectural choices
> are settled and deliberately not open for re-litigation.

## What this is

From **1 September 2032**, every vehicle placed on the EU market must carry a **Digital Circularity
Vehicle Passport** under [Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj),
which entered into force on 13 August 2026. The regulation requires that passport to be *"aligned,
interoperable and, where possible, integrated with other vehicle related environmental passports
established under Union law"* — most obviously the EV battery passport that becomes mandatory in
February 2027 under [Regulation (EU) 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj).

ShieldVIN implements that vehicle passport with **selective disclosure**: one canonical vehicle
record, anchored once, from which each party — buyer, dealer, recycler, insurer, regulator — can be
shown exactly what they are entitled to and provably nothing more.

The compliance obligation is the reason the passport exists. The reason it is *worth* building
privately is everything downstream of it: odometer fraud, title washing, undisclosed accident
history, and the ordinary asymmetry where a used-car buyer has no way to verify what they are told.

## How it works

A vehicle record is canonicalised, hashed, and anchored on Midnight. A parallel Merkle tree commits
to individual **provable fields**. From then on:

- **Anchoring** proves the record existed in a specific state at a specific time.
- **Predicate proofs** answer questions like *"is the odometer above 150,000 km?"* or *"has this
  vehicle ever been written off?"* — returning a yes or no that is verified on-chain, without ever
  revealing the underlying value.
- **Disclosure grants** control who may read which tier, enforced both in the API and on-chain.

The hard part is not the cryptography — [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE) already
provides it. The hard part is the honest one, described plainly in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): proving a number is *the anchored number* is not the
same as proving it is *true*. Closing that gap is what distinguishes this project, and it is
deliberately scoped as Phase 2 rather than pretended away in Phase 0.

## Built on

| | |
|---|---|
| [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE) | OData V4 gateway to Midnight — anchoring, ZK predicates, disclosure grants |
| [Midnight Network](https://midnight.network) | Zero-knowledge blockchain; ledger 8, Compact 0.31.x |
| [SAP CAP](https://cap.cloud.sap/) | Application framework — CDS domain model, OData services |

ShieldVIN is a **consumer application** of NIGHTGATE, in the same relation to it as
[NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) is for battery passports. We do not fork it, and
we contribute upstream where our needs are general rather than vehicle-specific.

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, the trust model, and its honest limits |
| [DECISIONS.md](docs/DECISIONS.md) | Settled decisions and the reasoning behind them |
| [ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan |
| [FIELDS.md](docs/FIELDS.md) | The provable-field registry and why it is capacity-constrained |

## Licence

Apache-2.0, matching the ODATANO stack.

---

<div align="center">
  Rebuilt August 2026 · <a href="https://midnight.network">Midnight Network</a> · <a href="https://github.com/ODATANO">ODATANO</a>
</div>
