# Contributing

Thanks for helping. Bug reports and pull requests are welcome at [GitHub Issues](https://github.com/ekenigs/work-history/issues).

## Setup

You need Node.js 24 or later, [pnpm](https://pnpm.io/), and the [GitHub CLI](https://cli.github.com/) to run `collect` against real data.

```bash
pnpm install
```

## Checks

Every pull request must pass these, the same as CI:

```bash
pnpm check   # Oxfmt formatting, Oxlint (type-aware) and type checking, via Vite+
pnpm test    # Vitest
pnpm build   # vp pack to dist/
```

`pnpm fix` formats and applies the safe lint fixes.

The lint config in `vite.config.ts` turns on every Oxlint category. A rule is off only with a comment that says why; add one the same way if you need to. Prefer changing the code over disabling a rule.

## Code layout

- `src/cli.ts` parses arguments and runs a command.
- `src/init.ts` is the interactive setup; `src/init-config.ts` holds its pure parts.
- `src/config.ts` reads and checks `work-history.config.json`; keep `schema.json` and `config.example.json` in step with it (a test checks the keys).
- `src/collect.ts` runs a collection; `src/backfill.ts` and `src/update.ts` are the two modes.
- `src/github.ts` and `src/local.ts` read GitHub (through `gh`) and local clones; `src/dedupe.ts` merges duplicates.
- `skills/work-history/SKILL.md` is the agent skill that turns the records into the log.

The CLI only reads. Writing the log is the skill's job.

## Tests and data

Test fixtures use made-up people, emails and repos (`example` domains, `acme`, `octocat`). Keep real names and emails out of the repo.
