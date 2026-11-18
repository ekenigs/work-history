# work-history

Keep a dated log of everything you shipped. `work-history` collects your merged pull requests and commits from GitHub (and, once, from your local clones), and an agent skill turns them into a Markdown file grouped by project, with links to every PR.

The log is the raw material for a resume, a cover letter, a performance review or a promotion case: specific features with dates, the stack you used and how you verified them, instead of what you remember.

```md
## Acme Monorepo (acme/monorepo)

The Acme web app and its API. 2025-03 → 2026-10.

- **File uploads** (2026-09 → 2026-10). [#561](https://github.com/acme/monorepo/pull/561), [#690](https://github.com/acme/monorepo/pull/690); about +1840/−210 lines across 37 files.
  - **What**: users drop PDFs on a form and see upload progress and a preview before submitting.
  - **How**: a FileDropZone component sends files straight to storage with signed URLs; the form submits only the keys.
  - **Stack**: TypeScript, React, S3.
  - **Verified**: Playwright tests for drop, progress and cancel.
- **Dark mode**: theme tokens and a toggle in the header. (2026-04)
```

## How it works

1. The `work-history` CLI reads GitHub through the [GitHub CLI](https://cli.github.com/) and prints your changes as JSON Lines: one record per merged PR or direct commit, deduplicated across branches and copies. `collect` only reads; it never writes your log.
2. The `work-history` [agent skill](skills/work-history/SKILL.md) runs the CLI, asks you which new repos count, writes the entries with a fixed rubric (one entry per feature, facts from PR text only), moves the cursor, and opens a pull request with the update.

Run it once to backfill your history, then as often as you like: every week, every month, whenever you remember. A late run catches up by itself, because the cursor in the file only moves when an update lands.

### Why a coding agent

The CLI gives you facts: titles, dates, links and line counts. A useful log needs judgment that no fixed rule gets right:

- **Grouping.** A feature often lands as several PRs over weeks: a schema change, the API, the UI, a follow-up fix. Seeing that they are one feature means reading them together.
- **Summarizing.** What and How come from PR descriptions written for reviewers, in any shape or length. The agent turns them into two plain sentences and reads the diff when a PR says nothing.
- **Filtering.** A review fix, a revert or a one-line config change can look like real work by its title. Telling them apart takes reading the change.
- **Sorting repos.** Deciding which repos count is your call; the agent asks you and records the answers.

The skill is plain Markdown in the open [Agent Skills](https://agentskills.io) format, so any agent that loads skills can run it, not only Claude Code.

### Without an agent

`work-history render` writes the log itself, one line per change, from the same records:

```md
- **Add file uploads** (2026-09). [#561](https://github.com/acme/monorepo/pull/561); +1840/−210 lines across 37 files.
```

It skips obvious noise (dependency bumps, merge, WIP and lint commits), writes only `approved` repos and moves the cursor. You get a complete, linked log with no AI involved, but a flat one: a feature built in five PRs takes five lines, and nothing says what or how. An agent can merge those lines into entries later.

## Requirements

- Node.js 24 or later.
- The GitHub CLI, signed in: `gh auth login`.
- A coding agent that loads skills from `.agents/skills` or `.claude/skills`, such as Claude Code, Codex or Cursor. Without one, use [`render`](#without-an-agent).

## Quick start

> [!NOTE]
> `work-history` is not on npm yet. Until it is, install it from source:
>
> ```bash
> git clone https://github.com/ekenigs/work-history.git
> cd work-history && pnpm install && pnpm build && pnpm add -g "link:$PWD"
> ```
>
> If pnpm says the global bin directory is not in `PATH`, run `pnpm setup`, open a new shell and try again. If `pnpm setup` says your shell config already has a pnpm section, it was written by an older pnpm that put a different directory on `PATH`. Run `pnpm setup --force` to replace it.
>
> The global install links to your clone, so `pnpm build` picks up changes without reinstalling. Remove it with `pnpm remove -g work-history`.
>
> Then use `work-history` wherever this README says `npx work-history`.

In the repo (or folder) where you want to keep your log:

```bash
npx work-history init
```

`init` finds your GitHub login and commit emails, asks you to confirm them, asks which folders hold your local clones, writes `work-history.config.json`, and offers to install the agent skill into `.agents/skills/work-history` (linked from `.claude/skills`).

Then ask your agent:

> Backfill my work history.

and after that, whenever you want to catch up:

> Update my work history.

In an agent that runs skills as slash commands, such as Claude Code, `/work-history backfill` and `/work-history update` do the same.

No agent? Add the repos you want to `approved` in the config, then run `npx work-history render backfill` once and `npx work-history render update` after that.

## Commands

### `work-history init`

Creates or updates `work-history.config.json`. Running it again keeps your approved and ignored repos and backfill settings.

The folders you name are saved under `backfill` for the backfill to read. `init` also compares your commits across the clones in them. When two repos share commits (a mirror, a fork, a package split out of a monorepo), it asks which repo that work counts under and saves your answer in `canonical`. It can only compare repos you have cloned, and it misses a copy that squashes commits, so add those pairs to `canonical` by hand.

| Option            | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `--config <file>` | Config file to write. Default: `./work-history.config.json` |
| `-y`, `--yes`     | Accept the detected values without prompts. Skips the scan. |

### `work-history collect backfill`

Reads all your history: merged PRs across GitHub, direct commits on your repos' default branches, and commits in the local clones listed under `backfill`.

### `work-history collect update`

Reads GitHub only, for the `approved` repos, from the cursor in your log (`<!-- last-scanned: YYYY-MM-DD -->`) to yesterday (UTC), the last complete day. Repos you worked in that are on neither list come out as `new-project` records for you to sort.

These options apply to both `collect` and `render`.

| Option               | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `--since YYYY-MM-DD` | Start of the window, exclusive. Default: 1970-01-01 (backfill) or the cursor. |
| `--until YYYY-MM-DD` | End of the window, inclusive, before today. Default: yesterday (UTC).         |
| `--repo owner/name`  | Limit to one repo; repeat for more. Skips the `new-project` scan.             |
| `--out <file>`       | `collect` only: write the JSON Lines to a file instead of stdout.             |
| `--config <file>`    | Config file. Default: `./work-history.config.json`                            |

### `work-history render backfill` and `work-history render update`

Collects like `collect` with the same options, then writes the records into your log with no agent: one line per change under its project, newest first. Only `approved` repos get entries; copies go under their `canonical` repo. It moves the cursor, never back, and skips changes the log already links to, so running it twice adds nothing. It lists the repos with your work that are on neither list, for you to add to `approved` or `ignored`.

Exit codes: `0` on success, `1` on a failure such as a GitHub error, `2` on bad usage or an invalid config. A GitHub error such as a rate limit stops the run with no output, so a log never moves past changes the run could not read.

## Configuration

`work-history.config.json` is checked on every run, and [`schema.json`](schema.json) gives your editor completion and checks. [docs/config.md](docs/config.md) explains every property: what it does, what fills it in, and when to edit it by hand. See [`config.example.json`](config.example.json) for a filled-in example.

| Field       | Description                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`     | Your GitHub login.                                                                                                                                              |
| `emails`    | Every email you commit with, including your `…@users.noreply.github.com` address.                                                                               |
| `output`    | The log file, relative to the config. Default: `work-history.md`.                                                                                               |
| `canonical` | Repos that carry copies of another repo's commits (a mirror or a split-out package), mapped to the source. That work counts once.                               |
| `approved`  | Repos the update run reads. The skill adds repos when you approve them.                                                                                         |
| `ignored`   | Repos the update run never suggests.                                                                                                                            |
| `backfill`  | Local clones for the backfill: `folders` to scan and `noGit` folders, as paths such as `~/Projects`, and `remote`, `branches` and `aliases` for unusual clones. |

Your config and log hold personal data, such as your emails. Keep them in a private repo.

## Output records

`collect` prints one JSON object per line. Types are exported from the package (`import type { CollectRecord } from 'work-history'`).

| `type`        | Fields                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `new-project` | `repo`, `evidence`: PR and commit lines from a repo on neither list.                                                          |
| `repo`        | `repo`, `canonical`, `localPath`, `branches`, `description`, `first`, `last`, `counts`, `warnings`. Precedes its changes.     |
| `change`      | `repo`, `kind` (`pr` or `commit`), `date`, `pr`, `sha`, `role` (`author` or `co-author`), `title`, `body`, `sources`, `size`. |
| `run`         | `mode`, `since`, `until`, `warnings`. Always last.                                                                            |

## Development

```bash
pnpm install
pnpm check   # format, lint and type-check with Vite+ (Oxfmt, Oxlint)
pnpm test    # Vitest
pnpm build   # bundle to dist/ with vp pack
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
