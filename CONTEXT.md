# cache-timer

Times how long the prompt cache of a Claude Code session stays warm, and helps the person act before it expires.

## Language

### Where the timer shows

**Status line**:
The countdown in Claude Code's status line, for checking the time left at a glance. It has no controls.
_Avoid_: footer, status bar

**Band**:
The single row above the prompt: the countdown plus the action to take on it now (compact). Off by default.
_Avoid_: bar (that is the progress bar inside it), banner, strip

**Pane**:
The side pane with the details: the last read and write, this session's stats, and the settings.
_Avoid_: panel, sidebar

### The timer

**Countdown**:
The time left before the cache expires, shown in whole minutes or as `m:ss`.
_Avoid_: timer (the whole mod), TTL (the cache's full lifetime)

**Auto-compact**:
A compaction the mod starts by itself shortly before the cache expires, when the person has turned it on. It is set in the pane; the band only shows whether it is on.
_Avoid_: auto mode

**Lead**:
How long before expiry auto-compact starts.
_Avoid_: offset, margin
