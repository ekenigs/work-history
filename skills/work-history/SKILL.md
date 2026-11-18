---
name: work-history
description: Keep a work-history Markdown file, a dated log of every feature the user shipped grouped by project, up to date from their GitHub PRs and commits. Use when the user asks to run, update, backfill or catch up their work history.
---

# Work history

The work-history file is the user's career log: every feature they shipped, grouped by project, with links to the PRs. The `work-history` CLI collects the changes; you turn them into entries with the rubric below.

`work-history.config.json` in the repo root (or the path the user gives) names the user's GitHub `login`, commit `emails`, the `output` file, and the `approved` and `ignored` repos. Read it first. If it is missing, ask the user to run `npx work-history init`.

The CLI needs the GitHub CLI, signed in (`gh auth status`). It only reads: it never edits the config or the output file. You do.

## Which run

The user can name the run as an argument to this skill: `/work-history backfill` or `/work-history update`. A request in plain words ("backfill my work history", "update my work history") means the same.

With no run named, choose by the output file: backfill when it does not exist yet or has no `<!-- last-scanned: YYYY-MM-DD -->` cursor, update otherwise.

When the named run does not fit the output file, say so and ask before you go on: a `backfill` for a file that already has a cursor would add to a log that is in use, and an `update` for a file with no cursor has no start date.

## First run: backfill

1. **Collect.** `npx work-history collect backfill --out "$TMPDIR/work-history.jsonl"`. This reads the user's merged PRs and commits across GitHub and, when `backfill.folders` is set, their local clones.
2. **Sort repos.** Each `repo` record is a project candidate. Show the user the repos with their counts and date ranges, in batches of up to 4 with `AskUserQuestion` when you have it: **Approve** or **Ignore**. Add the answers to `approved` or `ignored` in the config, keeping each list sorted.
3. **Write.** Create the output file: a `# Work history` heading, the cursor line set to the `run` record's `until`, then a project section for each approved repo, with entries from its `change` records by the rubric.

## Update run

A run covers everything since the cursor in the output file. The cursor moves only when the run's changes land, so a late or missed run catches up by itself.

1. **Gate.** If the output file sits in a git repo with a GitHub remote, `git fetch origin`. If `gh pr list --state open --json url,headRefName` lists a `work-history/` branch, stop and report "Merge or close <url> first." The CLI collects through yesterday (UTC), the last complete day. If the cursor is already that day or later, stop and report "Already scanned through <date>."
2. **Branch.** In a git repo only: `git switch -c work-history/<YYYY-MM-DD of today> origin/<default branch>`.
3. **Collect.** `npx work-history collect update --out "$TMPDIR/work-history.jsonl"`.
4. **New projects.** For each `new-project` record, ask the user, with its evidence in the question: **Approve**, **Ignore** or **Ask next time**. Add answered repos to `approved` or `ignored` in the config, keeping the lists sorted. Collect each newly approved repo with `npx work-history collect update --repo <repo> --since 1970-01-01` and give it a new project section. A run with `--repo` reads only that repo and prints no `new-project` records.
5. **Entries.** Apply the rubric to every `change` record. Done when each one is in a new entry, extends an existing entry, or is skipped under a named Skip rule.
6. **Cursor.** Set the cursor to the `run` record's `until`.
7. **Land.** Outside git, stop here and summarize the run. In git, commit the output file and the config as `Update work history through <until>`, push, and `gh pr create --title "Work history through <until>"`. Body: the window; each added or extended entry on one line; the repos the user sorted; the `run` record's warnings. A run with no qualifying work still gets the PR, with "No qualifying work" in the body.

## Records

The CLI prints JSON Lines. In order:

- `new-project` (update only): `repo` and `evidence` lines for a repo on neither list.
- `repo`: one per repo, then its `change` records. `canonical` is set when the config maps this repo to another; `warnings` can hold `github-404`, `stale-clone`, `no-default-ref`, `no-own-commits` or `no-git`.
- `change`: `kind` (`pr` or `commit`), `date`, `pr`, `sha`, `role` (`author` or `co-author`), `title`, `body`, `sources`, and `size` (`additions`, `deletions`, `files`) when known.
- `run`: `mode`, `since`, `until` and `warnings`. Always last.

## Rubric

### Keep and skip

- **Keep**: features, integrations, migrations or upgrades of major frameworks, infra and account moves, security fixes, test suites, performance work, SDK releases.
- **Skip**: dependency bumps, CODEOWNERS, wip/stash/index commits, review fixes, bare "Fixes" with no subject, formatting and lint.
- **One feature, one entry**: merge the changes that build one feature. A busy repo gets about 6 entries a year; a thin month gets none.
- **Copies count once**: a repo with a `canonical` value carries commits copied from that repo. Write that work under the canonical repo, once.

### Layout

An entry is a **rich entry** when it has at least ~100 changed lines and either 2+ changes or more than 500 changed lines. Everything else is a **one-liner**.

One-liner:

```
- **<feature>**: <short explanation>. (YYYY-MM)
```

Rich entry:

```
- **<feature>** (YYYY-MM[ → YYYY-MM]). <refs>; about +A/−D lines across F files.
  - **What**: what was built, from the user's point of view.
  - **How**: the implementation approach and notable design choices.
  - **Stack**: technologies actually touched.
  - **Verified**: how it was tested or rolled out.
```

- **Refs**: `[#N](https://github.com/<repo>/pull/N)`, sorted, at most 8, then "and N more". Size is the sum over all refs.
- **Verified** appears only when a PR or commit says how it was tested or rolled out.
- **Facts only**: every word comes from PR or commit text. Write no Why or Impact unless the source states it.
- **Thin PRs**: when a PR body says little, read changed paths and stats with `gh api repos/<repo>/pulls/<N>/files` and mark that detail _(from diff)_. Use it for what and how, never for intent.
- **_(co)_**: a change with `role: co-author` appears only as a `Co-authored-by` trailer. Keep it and mark the entry _(co)_.
- **Terms**: keep the project's own terms. Whoever reuses the log (a resume, a cover letter) adapts them.

### Placement

- **Order**: projects by last activity, newest first; entries newest first within a project.
- **Project header**: `## <Name> (<owner/repo>)`, then a one-line description and the active date range. Update the range when a project gets new entries.
- **Render drafts**: `npx work-history render` writes one line per change, such as `- **<PR title>** (YYYY-MM). [#N](…); +A/−D lines across F files.` When you work on a project that has such lines, fold them into feature entries by the rubric and keep their refs.
- **Extend** an entry when new changes clearly continue it: widen its date range, add the refs and size, revise What and How only where the new changes add something, and add Verified only when the source says so. A one-liner that now meets the rich threshold becomes a rich entry. Old content stays.

### Wording

- Plain words and active voice. Say what was built and how, with names and numbers from the source.
- No filler or hype: "robust", "seamless", "leverage", "enhance", "crucial", "showcase" and the like add nothing.
- Sentence case for headings. No emojis. Straight quotes.
- One idea per sentence. Write whole sentences, not arrows or symbol shorthand.
