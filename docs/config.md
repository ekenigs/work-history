# Configuration

`work-history.config.json` tells the CLI who you are, where your log is, and which repos count. `work-history init` writes it. Every command checks it before it runs and stops with exit code `2` and a list of problems when something is wrong.

[`schema.json`](../schema.json) gives your editor completion and checks, and [`config.example.json`](../config.example.json) shows every property filled in.

The config holds personal data, such as your emails and folder paths. Keep it in a private repo.

## Who fills in what

| Property    | Filled in by                                         | You edit it by hand when                                |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `$schema`   | `init`                                               | Never.                                                  |
| `login`     | `init`, from `gh`                                    | Your GitHub login changes.                              |
| `emails`    | `init`, from git and `gh`, plus the ones you type    | You start to commit with a new email.                   |
| `output`    | `init`                                               | You move or rename the log.                             |
| `canonical` | `init`, from the pairs it finds in your clones       | A copy is not cloned, or it squashes the commits.       |
| `approved`  | The skill, when you approve a repo                   | You use `render` with no agent.                         |
| `ignored`   | The skill, when you ignore a repo                    | You use `render` with no agent.                         |
| `backfill`  | `init` fills in `folders`; nothing fills in the rest | A clone is unusual. See [Backfill settings](#backfill). |

Running `init` again asks the same questions with your current values filled in. It keeps `approved`, `ignored` and the `backfill` settings it does not ask about.

## Top-level properties

### `$schema`

A link to the JSON schema, for editors. The CLI ignores it.

### `login`

Required. Your GitHub login, such as `octocat`.

Every GitHub lookup uses it: the search for your merged PRs, the search for your commits, and the list of commits you pushed to a branch.

### `emails`

Required, at least one. Every email you have committed with.

Local clones know authors by email only, so the backfill uses this list to find your commits in them. A commit counts when one of these emails is its author, or when it is in a `Co-authored-by` trailer. Matching ignores case.

List them all:

- your current email;
- your GitHub `…@users.noreply.github.com` address, which GitHub uses for commits made on the website;
- emails from former jobs, even when the address no longer exists.

A missing email means the commits made with it are not found in your clones. The update run reads GitHub only and finds your work by `login`, so it does not use this list.

### `output`

The log file, relative to the config file. Default: `work-history.md`.

The update run reads its cursor, `<!-- last-scanned: YYYY-MM-DD -->`, from this file.

### `canonical`

An object that maps a repo that carries copies of another repo's commits to that other repo. Default: `{}`.

```json
"canonical": {
  "acme/ui": "acme/monorepo"
}
```

This says that the commits in `acme/ui` also exist in `acme/monorepo`, and that the work counts once, under `acme/monorepo`. Use it for a mirror, a fork, or a package split out of a monorepo.

The CLI already merges commits that have the same hash. This map covers what a hash cannot:

- a copy with rewritten hashes, such as a `git subtree split`, a cherry-pick or a sync bot;
- which of the two repos the work is listed under.

`init` compares your commits across your local clones and asks about each pair that shares them. Add a pair by hand when one of the repos is not cloned, or when the copy squashes commits, because `init` cannot see those.

A mapping goes one level deep. Map every copy to the final repo, not to another copy. `init` does this for the pairs it asks about.

### `approved`

A list of repos, as `owner/name`, that your log covers. Default: `[]`.

- The update run reads only these repos.
- `render` writes entries only for these repos.

The skill adds a repo when you approve it. With no agent, add repos by hand before you run `render`.

### `ignored`

A list of repos, as `owner/name`, that you do not want in your log. Default: `[]`.

The update run reports every repo you worked in that is on neither list as a new project to sort. A repo on this list is never reported.

<a id="backfill"></a>

## Backfill settings

`backfill` holds the settings for `collect backfill` and `render backfill`, which read your local clones as well as GitHub. The update run does not use them.

Clones add what GitHub cannot show for your login:

- commits made with an email that is not linked to your GitHub account;
- repos in an organization you have left;
- repos that were never pushed to GitHub.

Only `folders` matters for most people. The other four are for clones that the scan gets wrong, and nothing fills them in for you.

Paths in this section are full paths. `~` stands for your home folder. A path that starts with neither `/` nor `~` is rejected, because it would point at a different folder each time you run the CLI from another place.

### `backfill.folders`

A list of folders to scan for git clones. Default: `[]`, which reads no clones.

```json
"folders": ["~/Projects", "~/work"]
```

The scan looks up to three levels below each folder and skips `node_modules` and folders whose name starts with a dot. It does not look inside a clone for more clones. Folders can overlap; each clone is read once.

A clone is named by its `origin` remote. Its default branch is read, as `origin` had it at your last fetch, so fetch a clone first if it is old. A clone that was never fetched, or not for a year, gets a `stale-clone` warning.

`init` also uses these folders to find the pairs for [`canonical`](#canonical).

### `backfill.noGit`

A list of folders that hold work with no git history. Default: `[]`.

```json
"noGit": ["~/Projects/side-projects/sketches"]
```

Each folder gets one record with the dates of its oldest and newest file, a description from its `package.json` or README, and a `no-git` warning. It has no changes, because there are no commits to read.

A folder that is in both `folders` and `noGit` is not scanned for clones.

### `backfill.remote`

An object that maps a clone's path to its `owner/name` on GitHub. Default: `{}`.

```json
"remote": {
  "~/Projects/acme/monorepo": "acme/monorepo"
}
```

Use it when a clone has no `origin` remote, or when `origin` is not a `github.com` URL. Without it, such a clone is named by its path under the scanned folder, and its work is not joined with the same repo on GitHub. When scanned folders overlap, the outermost one names the clone. When two such clones would get the same name, the second gets more of its path in front, such as `b/tool`.

### `backfill.branches`

An object that maps a clone's path to the branches to read. Default: `{}`.

```json
"branches": {
  "~/Projects/acme/monorepo": ["main", "release"]
}
```

The backfill reads only the default branch. Use this when your work is on a branch that was never merged into it, or when a clone has the `no-default-ref` warning, which means the default branch could not be found.

Name the branches as they are on `origin`, without the `origin/` prefix. The same branches are then read on GitHub for that repo.

### `backfill.aliases`

An object that maps an old repo name to its new one. Default: `{}`.

```json
"aliases": {
  "acme-old/api": "acme/api",
  "acme-old/*": "acme/*"
}
```

Use it when a repo or its owner was renamed after you cloned it. The clone's `origin` still has the old name, so its work would be listed apart from the repo's work on GitHub, often with a `github-404` warning.

A key is an exact `owner/name`, or `owner/*` for every repo of an owner. An exact name wins over `owner/*`. The `*` in the value is replaced with the repo's name.

## Warnings that point at a setting

A `repo` record from the backfill can carry warnings. These are the ones a setting fixes:

| Warning          | Meaning                                                | Setting to check                        |
| ---------------- | ------------------------------------------------------ | --------------------------------------- |
| `no-default-ref` | The clone's default branch could not be found.         | `backfill.branches`                     |
| `github-404`     | GitHub has no repo with this name, or you lost access. | `backfill.aliases` or `backfill.remote` |
| `no-own-commits` | No change of yours was found in the repo.              | `emails`                                |
| `stale-clone`    | The clone was never fetched, or not for a year.        | None. Run `git fetch` in the clone.     |
| `no-git`         | The folder is listed in `backfill.noGit`.              | None.                                   |

## Settings from older versions

`backfill.projectsRoot` and `backfill.localFolders` were replaced by `backfill.folders`. A config that still has them is rejected. Write each scanned folder as a full path in `folders`, and change the entries of `noGit` and the keys of `remote` and `branches` to full paths.
