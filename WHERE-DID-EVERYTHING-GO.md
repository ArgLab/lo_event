# You've followed a pointer into history

A commit message somewhere (probably "Reliable delivery: durable outbox,
identity acks, sans-I/O engine", the 0.0.9 consolidation on
`pmitros/2026-04-loevent-fixes`) sent you to this branch name. The history
it pointed at is intact — it just lives under a tidier name now, together
with its siblings:

```
archive/ack-protocol/
├── 0-development     the original build-up: ack protocol, lease/confirm
│                     queues, and the flush barrier, grown iteratively on
│                     top of 0.0.8 through many review cycles
├── 1-spec            the reset: the implementation was ablated back to
│                     baseline and the accumulated knowledge was written
│                     down instead — docs/reliable-delivery.md, a spec with
│                     a "landmine registry" of every bug that had shipped,
│                     each pinned as an invariant
└── 2-build-…         three cleanroom implementations of that spec, built
    ├── …opus         in parallel by three model instances, each blind to
    ├── …fable        the others' code, then cross-reviewed against each
    └── …sol          other and hardened
```

## How this went, in one paragraph

The first implementation (`0-development`) worked, but accreted ~2,000
lines of review-scar tissue faster than anyone could keep the whole design
in their head. So we inverted the process: rewind the code, keep the
lessons. Everything learned was written into a specification assuming no
prior knowledge (`1-spec`), the load-bearing surfaces were ablated, and
three independent builds raced against the spec with the shared test
suites as the acceptance gate. They converged on nearly identical
architectures — a sans-I/O decision engine with facts in and decisions
out — which was the strongest evidence the spec was right. Sol's build
(`2-build-sol`, the leanest) became the synthesis base, taking a probe
race fix prompted by review and adversarial tests grafted from its
siblings. The result was squashed into a single coherent commit on
`pmitros/2026-04-loevent-fixes` and shipped as `0.0.9-ack.0`.

## Where things are

- **The shipped code**: one commit on `pmitros/2026-04-loevent-fixes`,
  tagged and published from there (npm dist-tag `ack`, then `latest`).
- **The spec**: `docs/reliable-delivery.md` on
  `archive/ack-protocol/2-build-sol`, pending its permanent home in the
  architecture docs. Read it before touching the delivery code; §8's
  landmine registry is the list of ways this has already gone wrong.
- **Why each decision was made**: the spec's history notes, plus
  `docs/implementation-notes.md` on the same branch.

This file is the only content of this branch, on a commit with no
parents — a bookmark, not a lineage.
