## Agent skills

### Issue tracker

Issues live in GitHub Issues for `ekenigs/work-history`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

- `pnpm check` formats, lints and type-checks; `pnpm test` runs Vitest; `pnpm build` bundles with `vp pack`. Run all three before you finish.
- Lint rules are off only with a comment in `vite.config.ts` that says why. Fix the code rather than disabling a rule.
- When the config shape changes, update `src/config.ts`, `schema.json`, `config.example.json` and the README table together.
- When the record format or the rubric changes, update `skills/work-history/SKILL.md`.
- Test data uses made-up people and repos. Never commit a real `work-history.config.json` or `work-history.md`; `.gitignore` excludes them.
