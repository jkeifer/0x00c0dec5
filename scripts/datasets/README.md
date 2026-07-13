# Dataset assets — extraction & publishing

Real data lives on the orphan `data` branch, never on main. The app fetches
`https://raw.githubusercontent.com/jkeifer/0x00c0dec5/data/datasets/<id>/…`
(see `src/datasets/registry.ts`; in dev, the vite middleware serves
`data-branch-work/` with a `tests/fixtures/datasets/` fallback).

## Extract (writes to gitignored data-branch-work/)

    npx tsx scripts/datasets/etopo-dem.ts
    npx tsx scripts/datasets/sst-field.ts
    npx tsx scripts/datasets/ghcn-daily.ts

## Publish to the data branch (by hand — agents never touch the remote)

    git worktree add ../0x00c0dec5-data data 2>/dev/null \
      || git worktree add --orphan -b data ../0x00c0dec5-data
    rsync -a --delete data-branch-work/datasets/ ../0x00c0dec5-data/datasets/
    cd ../0x00c0dec5-data
    git add -A && git commit -m "data: refresh dataset assets"
    git push -u origin data
    cd - && git worktree remove ../0x00c0dec5-data

## Fixtures

`scripts/datasets/gen-fixtures.ts` regenerates the tiny committed fixtures in
`tests/fixtures/datasets/` (synthetic, deterministic, no network). Keep their
variable names/dtypes in lockstep with the real scripts — the fixtures unit
test cross-checks them against the registry.
