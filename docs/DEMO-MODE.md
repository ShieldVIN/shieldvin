# Demo mode: real preprod runs, for anyone

Wave 1 status: **engine and API built and proven; public UI ships in Wave 2's
"full preprod wiring" milestone.** Everything below runs today behind
`VINPASSPORT_PREPROD=1`.

The site's intake console runs the real compiled circuits in-process, which
proves the contract logic but not the chain. Demo mode closes that gap: a
visitor triggers a run that registers a passport, records history, and proves
claims **on the deployed preprod contract** (`deploy/preprod.json`), pays real
dust fees from the project wallet, and walks away with two artifacts:

1. **On-chain evidence** — transaction hashes and block heights anyone can
   check against the public indexer, plus the exact `curl` to do it.
2. **A receipt file** — the *private half* of the passport: every value and
   salt, none of which ever touched the chain. The receipt is the ownership
   proof: whoever holds it can open the commitments; nobody else can.

## Two routes, one engine

The surfaces: **`/demo/`** runs the guided route and renders the stepper;
**`/intake/`** carries a *Submit to Midnight preprod* toggle that sends the
registrar's own intake down the same engine. Both share
`site/assets/preprod-run.mjs`, so neither can drift from the other.

| Route | Who drives | What happens |
|---|---|---|
| **Guided** (`POST /api/demo/run`) | The server | A plausible vehicle is generated (fresh random `VPD…` VIN), registered with four live fields and a panel of declarations, given one odometer update, then asked four questions — **one of which is designed to fail**: "one keeper" on a two-keeper car. The visitor watches the circuit refuse it, and the refusal appears in the report as a result, not an apology. |
| **Manual** (`POST /api/demo/intake`) | The visitor | The same intake shape the console uses — fields, panel declarations, up to two update rounds, requested claims — but executed on preprod. The VIN is **always server-generated** (`VPD` prefix): demos never squat a real VIN and never collide with each other. |

Both routes share one queue (runs never conflict), one engine, and one cap.

## The cap

**5 runs per UTC day, global, guided and manual counted together.** The status
endpoint shows used/remaining and the reset time, so the limit is visible
before anyone starts. A run counts when it starts, whether or not it succeeds
— retry-spam cannot stretch the budget. The cap exists because every run
writes permanent public state and spends real (self-replenishing) dust.

## Anatomy of a run

```
simulate      dry-run every step through the compiled circuits, locally.
              In-circuit refusals are caught HERE, reported, and never
              submitted — a failed proof writes nothing, so nothing is sent
              that would fail.
wallet        confirm the funding wallet is at the chain tip.
then per stage (a stage = one transaction, up to 8 batched calls):
  build       prove the contract calls in-process (wasm), sign with our key
  fund        balance the fee in dust from our wallet, prove the dust spend
  submit      one-shot WebSocket JSON-RPC to the preprod node
  confirm     watch the public indexer until the call is in a block
receipt       assemble the downloadable report
```

Calls are packed into as few transactions as the ledger allows, in dependency
order. Two rules decide the packing, and both were learned from rejected
transactions rather than from any signature:

**A call that updates an already-populated cell must be last in its
transaction.** The ledger's sequencing check refuses such a call when a later
intent follows it, and the node reports only a bare `1010` (sub-code 188).
Reading our own circuits tells you which calls those are:

| Circuit | Writes | Populated cell? |
|---|---|---|
| `registerPassport` | fresh `vinHash` into `passports` + `registrar` | no |
| `initialiseField` | fresh slot, then `updateCount.increment()` | **yes, the counter** |
| `recordField` | **overwrites** the slot, then `updateCount.increment()` | **yes, twice** |
| `proveFieldAtMost` | fresh `claimKey` into `claims` | no |

`updateCount` is a `Counter` — one cell, always populated — which is why
initialisations and updates each close a transaction, while registration and
proofs batch freely. It is also why the vendor's "anchor first, then proofs"
shape is the one that works. A guided run collapses from nine transactions to
five: `[register + first init]`, `[init]`, `[init]`, `[update]`, `[all claims]`.

**Per-call private state must be armed explicitly.** nightgate-tx runs a
call's `before` hook only when the transaction carries a *batch*; a single
call is proven with the witnesses exactly as they stand. An unarmed holder
reads as value 0 with a zero salt — and since `initialiseField` asserts
nothing about prior state, that **proves and lands**, writing a commitment
nobody can ever open. The engine therefore arms the first call itself and the
witness holder refuses to be read until something has armed it, so a missed
arming is a loud build error instead of a quiet zero on the public chain.
`test/app/preprod-plan.test.mjs` pins both rules.

A guided run is five transactions and lands in roughly eight minutes; the job
API exposes each step's live status so a UI can render the wait as the story
it actually is: *this is a zero-knowledge proof being made and a real chain
accepting it*.

## The API

| Endpoint | Returns |
|---|---|
| `GET /api/demo/status` | `enabled`, `ready`/`warming`, capacity/used/remaining, reset time, queue length, contract address |
| `POST /api/demo/run` | `202 {jobId}` — guided run queued |
| `POST /api/demo/intake` | `202 {jobId}` — manual run queued (body: `fields`, `panel?`, `updates?`, `prove?`, `registrar?`) |
| `GET /api/demo/job?id=` | Job status + per-step progress + receipt when done |
| `GET /api/demo/report?id=` | The receipt as a file download |
| exhausted cap | `429` with the reset time |
| refused/failed steps | In the report, with the in-circuit reason |

## The receipt is the passport

The receipt carries the VIN, every field's value+salt per write, the panel
declarations, the per-run salt seed and the derivation rule, the content root,
the claim outcomes (proven / refused), and the transaction list with the
indexer query to verify it. Two properties worth stating plainly:

- **Completeness**: the content root and every field commitment can be
  recomputed from this file alone. Holding it *is* owning the passport.
- **Privacy**: each run uses a fresh random salt seed, so no two demo
  receipts are linkable and no receipt reveals anything about another run.

## Trust and key model

- The server holds the **only** writer key (the deploy wallet). Visitors
  never hold keys, sign nothing, and cannot write anything except through
  the capped, validated demo endpoints.
- Secrets stay in two env-pointed files outside the repo: the seed file and
  the wallet snapshot directory. Nothing in `site/` or this repo can reach
  them.
- The public site (GitHub Pages) stays static; only the API host runs the
  engine. CORS on `/api/*` admits exactly the passport.vin origins.

## Enabling it

```
VINPASSPORT_PREPROD=1
VINPASSPORT_SEED_FILE=/path/to/seed.env        # VINPASSPORT_SEED_HEX=<128 hex>
VINPASSPORT_STATE_DIR=/path/to/wallet-state    # {shielded,unshielded,dust}.blob
VINPASSPORT_DEMO_CAP=5                         # optional
node scripts/app-server.mjs
```

Without `VINPASSPORT_PREPROD=1` the server is exactly what judges clone and
run: in-process circuits, in-memory ledger, no wallet, no chain, no secrets.

Three things a deployment needs that a clone does not:

1. **The prover keys.** `contracts/vinpassport/src/managed/vinpassport/keys/`
   is gitignored — 18 MB of build artifacts that `compact compile` regenerates,
   and that the simulator (which proves nothing) never touches. Real proving
   does need them, so they have to be copied to the host or recompiled there.
2. **A synced wallet.** Building the dust state from nothing replays the whole
   preprod event stream, so the snapshots are copied in rather than rebuilt.
3. **Sole ownership of that wallet.** Two processes on one seed spend the same
   dust twice and both get rejected, so exactly one host runs the engine.

## How it is deployed

Two services, because restoring the wallet is heavy synchronous WASM work that
blocks the Node event loop outright on a small box — a single process would
take the public API down for minutes on every restart:

| Service | Port | Holds the wallet | Job |
|---|---|---|---|
| `vinpassport-app` | 8790 | no | the public API, always answering |
| `vinpassport-demo` | 8791 | yes | the preprod engine, blocks while it warms |

Caddy routes `/api/demo/*` to the engine and everything else to the API, so a
warming engine never delays anything else. The client half knows this too: a
service that accepts the connection and says nothing is reported as *starting*
rather than absent, and the demo page rechecks until it is ready.
