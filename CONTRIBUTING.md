# Contributing

Thanks for considering a contribution. mountproof is small on purpose — the value sits in a few well-chosen primitives (mount proof, declarative trajectories, multi-metric diff). Keep additions consistent with that.

## Local setup

```bash
pnpm install
pnpm playwright install chromium   # for the example app
pnpm typecheck
pnpm test
pnpm build
```

## Adding a new proof type

`mountProof` currently supports seven types — see `src/types.ts` for the discriminated union and `src/mount-proof.ts` for the runners. To add an eighth:

1. Extend the `ProofType` union in `src/types.ts`.
2. Add a runner to the `RUNNERS` record in `src/mount-proof.ts`.
3. Add a branch to `describeProof()` for the error message.
4. Cover it in `test/mount-proof.test.ts` (one happy path, one missing-proof failure path).
5. Document it in the proof-types table in `README.md`.

Keep proof types **objective and self-contained** — anything that requires a live network handshake to verify probably belongs in a custom `step`, not a proof. The whole point is fail-fast before the slow part runs.

## Conventions

- TypeScript strict mode, no `any` in exported signatures.
- No new runtime dependencies without a clear "why" — small surface, easy to vet.
- Tests use Vitest. The core engine MUST stay testable without a real browser (use the `PageLike` interface).
- Prose: direct, factual, no marketing language.

## Reporting issues

Include: trajectory JSON (minimal repro), mountproof version, Playwright version, exit code, the full error message, and what you expected.
