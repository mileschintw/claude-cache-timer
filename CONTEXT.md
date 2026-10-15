# cache-timer

Times how long the prompt cache of a Claude Code session stays warm, and helps the person act before it expires.

## Language

### Where the timer shows

**Status line**:
The countdown in Claude Code's status line, for checking the time left at a glance. It shows a bar and the time left (the default), the time alone, or nothing. It has no controls; Claude Code labels it `cache-timer`.
_Avoid_: footer, status bar

**Band**:
The single row above the prompt: the countdown plus the action to take on it now (compact). On by default.
_Avoid_: bar (that is the progress bar inside it), banner, strip

**Pane**:
The side pane with the details: the last read and write, and the settings.
_Avoid_: panel, sidebar

### The timer

**Countdown**:
The time left before the cache expires, shown in whole minutes or as `mm:ss`.
_Avoid_: timer (the whole mod), TTL (the cache's full lifetime)

**Auto-compact**:
A compaction the mod starts by itself shortly before the cache expires, when the person has turned it on. It is set in the pane, as off or a threshold; the band says when it will run, and says nothing while it is off, so it isn't mistaken for Claude Code's own auto-compact.
_Avoid_: auto mode

**Threshold**:
The least context, in tokens, that auto-compact acts on: 50k, 100k, 200k or 500k. Picking one turns auto-compact on.
_Avoid_: minimum, floor

**Lead**:
How long before expiry auto-compact starts.
_Avoid_: offset, margin
