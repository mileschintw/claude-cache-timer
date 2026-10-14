# cache-timer

A Claude Code function-hook mod. All logic is in `hooks/register.tsx`; the state contract is in `types/index.d.ts`; tests are in `tests/`.

## Checks

CI (`.github/workflows/ci.yml`) runs these on every push and pull request. Run them locally before committing:

```bash
claude plugin validate .
claude plugin test .
```

Don't use `validate --strict`: the `CLAUDE.md` at the plugin root always raises a warning.

For a type check, load the mod in Claude Code once. That writes types and a tsconfig to `.claude-plugin/types/` (gitignored). Then run `npx -p typescript@5.6.3 tsc -p .`.

## Conventions

- Every UI string goes through `STRINGS` and exists in both `en` and `zh-TW`.
- A user-facing change updates both `README.md` and `README.zh-TW.md`.
- A functional change bumps `version` in `.claude-plugin/plugin.json`.
- Commits, issues and READMEs are in English.

## Releases

The marketplace entry in `.claude-plugin/marketplace.json` is pinned to a release tag, so users get only releases, not every commit on `main`.

The release job in CI runs after the checks pass on a push to `main`. It releases when the version's release line differs from the latest `cache-timer--v*` tag. The release line is `major.minor` while the major is 0, and the major from 1.0.0 on. So 0.2.0 → 0.3.0 or 1.x → 2.0.0 releases, and 0.2.0 → 0.2.1 doesn't.

A release does three things:

- creates the `cache-timer--v<version>` tag;
- creates a GitHub release;
- pushes a bot commit to `main` that re-pins the marketplace entry. Pull `main` afterwards.

Directory listing on claude.ai is a separate, manual submission and isn't part of CD.

## Mod API pitfalls

- A helper that takes `$` must be a top-level `function` declaration, or validation fails.
- A render hook must not write state. Write state only in event hooks and button handlers.
- When the mod calls `$.session.compact()` itself, its own `session.compact` hook doesn't fire, so `compactNow` calls `markCompacted` itself.
- `$.session.compact()` rejects while a turn is running, and resolves `{ skip }` when vetoed.
- `$.ui.notify` is missing in tests, and the desktop app shows no system notification, so always go through `notify()` (try/catch).
- When `$.ui.open` returns `{ isPlaced: false }`, show the summary as a toast instead.
- On a 5m cache the auto-compact lead is capped at 60 seconds, otherwise short pauses compact.

## Testing pitfalls

- Mocks for op events return `{ value: ... }`.
- A `ui.render` stub must return a valid element.
- The test `$` has no `state`: check results by mounting the pane or band and using `ui.find`.
- The compact mock must not return empty `messages`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on mileschintw/claude-cache-timer, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
