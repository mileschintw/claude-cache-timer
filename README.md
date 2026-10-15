# claude-cache-timer

**English** | [繁體中文](README.zh-TW.md)

A Claude Code mod that counts down your prompt cache TTL, warns you before it expires, and can compact the conversation just before it lapses, so you don't pay to re-cache a long context.

```
cache ██████████████░░░░░░░░░░░░░░░░ 27:43 / 60:00  auto-compact off  [ Compact ] [ Pane ] [ Hide ]
Last read/write 32 min ago · read 182k · wrote 3k
```

The interface is in English by default and also available in Traditional Chinese (see [Language](#language)).

## Why

Claude Code caches the conversation prefix it sends with every request. While that cache is warm, each new message reads the whole context back at a fraction of the normal input price. Once the cache's TTL (5 minutes or 1 hour) runs out, the next message has to write the entire context to the cache again, and cache writes cost more than ordinary input.

On a long session that is a real cost, and nothing in the UI tells you when it is about to happen. This mod shows how much time the cache has left. It reminds you before the cache expires, and it can compact the conversation while the cache is still warm, so the next message re-caches a short summary instead of the full transcript.

## Features

- **Countdown in the status line.** The time left shows in the status line, such as `Cache has 27 / 60 min left` (whole minutes until the last 5 minutes, then `mm:ss`), or `Cache expired`. On by default.
- **Optional countdown band above the prompt.** Off by default. A progress bar that goes from green to yellow to red, with the time left, the last read and write sizes, and buttons to compact, open the pane, or hide the band.
- **`/cache` pane.** Shows the time left, this session's hit rate, expiries and compactions, and a sparkline of how much of each request the cache served. It also holds the settings.
- **Reminders.** A toast 5 minutes before a 1h cache expires (1 minute before a 5m one), and another when it has expired.
- **Optional auto-compact.** Off by default. When on, it compacts the conversation 1, 2 or 5 minutes before expiry, while the cache is still warm.
- **One-click compact.** From the band or the pane.
- **English or Traditional Chinese.** Pick the interface language in the plugin's settings, in the pane, or with `/cache lang`.
- **TTL detection.** The TTL starts at 1h and corrects itself from what the API reports. A cache read after more than 5 minutes proves 1h. A full re-write after 5 to 55 minutes proves 5m. A model switch also reports the TTL directly.

## Install

In a terminal session of Claude Code:

```
/plugin install cache-timer --marketplace mileschintw/claude-cache-timer
```

Answer `y` to add the marketplace, then pick the user scope. Once installed at the user scope, the mod also loads in the Claude desktop app's Code tab. The `/plugin` command itself isn't available there, so run the install from a terminal.

The marketplace installs the latest [release](https://github.com/mileschintw/claude-cache-timer/releases), not the tip of `main`.

<details>
<summary>Run it from a clone instead</summary>

```bash
git clone https://github.com/mileschintw/claude-cache-timer.git ~/.claude/mods/cache-timer
```

Then add the folder to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/cache-timer"
  }
}
```

Every session started after that loads the mod.
</details>

**Requirements:** a Claude Code build with function-hook mods (an early-access API). Tested on Claude Code 2.1.295 in the terminal and in the desktop app.

## Usage

The countdown appears in the status line after your first message. Everything else lives in `/cache`:

| Command | What it does |
| --- | --- |
| `/cache` | Open the pane. Where no pane can be placed, prints the same figures. |
| `/cache auto on` / `off` | Turn auto-compact on or off |
| `/cache ttl 5m` / `1h` | Set the TTL by hand |
| `/cache status on` / `off` | Show or hide the countdown in the status line (on by default) |
| `/cache band on` / `off` | Show or hide the band above the prompt (off by default) |
| `/cache seconds on` / `off` | Show `mm:ss` the whole time instead of whole minutes until the last 5 minutes (off by default) |
| `/cache lang en` / `zh-TW` | Switch the interface language |

Settings are saved across sessions.

### Language

The band, pane, reminders and `/cache` replies are drawn in English (`en`, the default) or Traditional Chinese (`zh-TW`). There are three ways to switch:

- **Plugin setting.** The `lang` option of the plugin, a picker in `/config`. You can also choose it when you install.
- **The pane.** The *Language* row in `/cache` has a button for each language.
- **`/cache lang en`** or **`/cache lang zh-TW`**.

The latest change wins. A language picked in the pane or with `/cache lang` is saved with the other settings and stays until the plugin setting itself changes; changing the plugin setting then switches the interface to the new value.

## How it works

- **Timing.** Every model request on the main thread reports how many tokens it read from the cache and how many it wrote. A request that read or wrote any restarts the countdown from that moment. Subagent requests use their own caches and are ignored.
- **After a restart.** The timer and this session's stats are saved as they change (for the 20 most recent sessions), so reopening the app or resuming the session picks the countdown up right away. A session last used before this version, or a fork, has nothing saved; its countdown is estimated from when the transcript's last response came in, and the band shows only its context size.
- **Auto-compact rules.** Auto-compact only fires when Claude is idle, at most once per cache window, and only when the context is at least 20k tokens. Below that, a summary saves too little to be worth the detail it drops. On a 5m cache the lead time is capped at 1 minute, so a pause shorter than 4 minutes never triggers a compaction.
- **Compacting in the desktop app.** The desktop app (and any SDK or `-p` session) can't compact from a mod directly, so the Compact buttons run `/compact` there, which shows its own result in the transcript.
- **Resets.** Any compaction, whether `/compact`, Claude Code's own auto-compact, or this mod's, replaces the cached prefix. The timer then waits for the next message.

## Limitations

- **No system notifications in the desktop app.** There, reminders are in-app toasts only. If you have walked away from the window, you won't see them.
- **The countdown is an estimate.** It is measured from when the response finished. The API's own clock may differ by a few seconds.
- **The band hides while a dialog replaces the prompt.** Claude Code doesn't draw the band while a dialog takes the prompt's place: a question (in the terminal), a plan approval, or the desktop app's next-step card. The band comes back once you answer. In the desktop app the status line stays visible under the next-step card, so the countdown is still there. In the terminal the status line is hidden too.
- **Compaction loses detail.** That is why auto-compact is off by default.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The hooks module is [`hooks/register.tsx`](hooks/register.tsx). Its state contract is [`types/index.d.ts`](types/index.d.ts), and the tests are in [`tests/`](tests/).

## License

[MIT](LICENSE)
