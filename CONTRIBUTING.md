# Contributing

Thanks for helping. Bug reports and pull requests are welcome at [GitHub Issues](https://github.com/ekenigs/work-history/issues).

## Setup

You need Node.js 24 or later, [pnpm](https://pnpm.io/), and the [GitHub CLI](https://cli.github.com/) to run `sync` against real data.

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

## Running your build as the CLI

Link your clone as the global `work-history`, so `pnpm build` picks up changes without reinstalling:

```bash
pnpm build && pnpm add -g "link:$PWD"
```

If pnpm says the global bin directory is not in `PATH`, run `pnpm setup`, open a new shell and try again. If `pnpm setup` says your shell config already has a pnpm section, it was written by an older pnpm that put a different directory on `PATH`. Run `pnpm setup --force` to replace it. Remove the link with `pnpm remove -g work-history`.

## Releasing

Maintainers release from an up-to-date `main` with a clean working tree:

```bash
pnpm version patch   # or minor, or major: bumps package.json, commits and tags vX.Y.Z
git push --follow-tags
```

The tag starts `.github/workflows/release.yml`, which checks that the tag matches `package.json`, runs the checks, tests and build, publishes to npm and creates a GitHub release with notes generated from the merged pull requests. Pull request titles become the changelog, so write them for users.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/), so there is no npm token in the repo. The trusted publisher on npmjs.com must name this repository and the workflow file `release.yml`.

## Tests and data

Test fixtures use made-up people, emails and repos (`example` domains, `acme`, `octocat`). Keep real names and emails out of the repo.
