# Settings live in the mod's store, not in userConfig

Status: accepted, 2026-10-15

## Context

The mod keeps its settings (TTL, auto-compact and its threshold, lead, band, status line, seconds, language) in its own `$.store`. The pane and `/cache` change them. Only `lang` is also a `userConfig` field, so it can be picked at install time.

Claude Code shows each `userConfig` field as a row in the `/config` menu and stores it in `settings.json` under `pluginConfigs`. Moving every setting there looked attractive: an agent, a dotfile or managed settings could set them without the pane.

## Decision

Settings the person changes while working stay in the mod's store, changed through the pane and `/cache`. `userConfig` holds only values set once, at install time; today that is `lang`.

## What we tried

A spike moved "Always show seconds" into `userConfig`. The pane's button wrote it back with `$.config.set`, and `register` applied `options.seconds` on every load. In the app:

- The desktop app has no `/config` menu, so the row was only reachable in the terminal. The pane is the one surface every client draws.
- A change in `/config` reached the pane: the engine reloads the mod with the new `options`.
- A change in the pane did not reach `/config`. We didn't pin down whether `$.config.list()` missed the row or `$.config.set` refused it.
- `/config` reloads the mod only when the value changes. Once the pane and `/config` disagreed, saving the `/config` value again did nothing.
- Every write from the pane would reload the whole mod, dropping its timers and module state.

Two copies of each setting, synced in both directions, are the problem; `lang` already needs a "config wins only when it changed since last seen" rule to stay consistent.

Automation already has a path: `/cache auto 100k`, `/cache status time` and the other subcommands set everything the pane does.

## Revisit when

- the desktop app gains a `/config` menu, or
- a plugin can write its own `userConfig` reliably without reloading itself, or
- people ask to manage these settings from files, for example through managed settings.
