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
- Never edit `version` in `.claude-plugin/plugin.json` by hand; CI fails if a commit changes it. To release, add a `Release:` trailer (see Releases).
- Commits, issues and READMEs are in English.

## Releases

The marketplace entry in `.claude-plugin/marketplace.json` is pinned to a release tag, so users get only releases, not every commit on `main`. The entry uses a `url` source with the HTTPS clone URL, not a `github` source: Claude Code clones a `github` source over SSH, which fails on machines without a GitHub host key or SSH key.

Every version is a release, and only a release changes the version. A commit asks for one with a trailer at the end of its message, before `Co-Authored-By`:

```
Release: patch
```

The value is `patch`, `minor` or `major`. A push with no such trailer releases nothing. If several pushed commits carry one, the push releases once, at the highest level.

The release job in CI runs after the checks pass on a push to `main`. `.github/scripts/next-version.sh` reads the trailers and works out the next version. Then the job:

- pushes a bot commit `Release cache-timer <version>` that sets `version`;
- tags that commit `cache-timer--v<version>` and moves the `release` branch to it, which the claude.ai plugin directory tracks;
- pushes a second bot commit that re-pins the marketplace entry to the tag;
- creates a GitHub release with generated notes.

Pull `main` afterwards.

The trailers are read once, for the push that carries them. If the release job fails (for example `main` moved during the checks and its push was rejected), the request is not picked up later; retry with an empty commit that carries the trailer: `git commit --allow-empty -m "Retry the release" -m "Release: patch"`.

The directory listing on claude.ai is submitted by hand at claude.ai/directory/manage, tracking the `release` branch; after that, each release reaches it through that branch.

## Mod API pitfalls

- A helper that takes `$` must be a top-level `function` declaration, or validation fails.
- Write every `$` call plainly as `$.noun.method(...)`: no cast, parentheses, `!` or `?.` around its parts. The plugin directory checks the source as written and blocks anything else. For a call the shipped types lack (`$.ui.notify`), put `// @ts-expect-error` on the line above.
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
