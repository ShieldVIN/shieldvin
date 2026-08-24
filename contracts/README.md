# Contracts

ShieldVIN's own Compact contracts. Layout follows
[NIGHTGATE's convention](https://github.com/ODATANO/NIGHTGATE/tree/main/contracts) —
`<name>/src/<name>.compact` with compiled output under `src/managed/<name>/`.

| Contract | Circuits | Purpose |
|---|---|---|
| `shieldvin-passport` | `registerPassport`, `initialiseOdometer`, `recordReading`, `proveOdometerBelow` | The vehicle passport: registration, and odometer readings held as private state |

## Building

**Compact has no native Windows binary, and on a Windows host `compact` resolves to the built-in
NTFS compression utility.** Always build in WSL2, macOS, or Linux.

```bash
compact compile contracts/shieldvin-passport/src/shieldvin-passport.compact \
                contracts/shieldvin-passport/src/managed/shieldvin-passport
```

Add `--skip-zk` for a fast syntax and type check that skips PLONK key generation.

Verified with **Compact CLI 0.5.2, compiler 0.31.1 (language 0.23, ledger 8)** — the stable line.
The ledger-9 line (compiler 0.33+) is not deployed to any public network.

## The private-state model

The odometer reading never reaches the ledger. Only `persistentCommit(reading, salt)` is stored.

`recordReading` requires the caller to open the *existing* commitment in-circuit — proving they know
the previous reading — then asserts the new reading is not lower, and replaces the commitment. Both
readings stay witnesses throughout, so the chain records that a monotonicity check passed without
recording what passed it.

`proveOdometerBelow` does the same for a public bound: it proves the hidden reading sits at or below
a threshold without disclosing it.

## What this does and does not prove

It proves a reading is **the one that was committed** and that it satisfies a bound. It does not
prove the reading matches physical reality — a producer who commits a false value produces a
cryptographically valid proof of a false fact.

That gap is closed by hardware attestation at source, which is Phase 2. See
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
