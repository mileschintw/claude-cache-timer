# claude-cache-timer

**English** | [繁體中文](README.zh-TW.md)

[![Release](https://img.shields.io/github/v/release/mileschintw/claude-cache-timer?label=release)](https://github.com/mileschintw/claude-cache-timer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A prompt cache countdown and auto-compact for Claude Code. See how long your cache stays warm, and compact before it expires instead of paying to re-cache a long context.**

![The cache-timer band above the prompt in the Claude desktop app, with the status line countdown next to the model picker below the prompt](docs/images/band-desktop.png)

Works in the Claude Code terminal and in the Claude desktop app's Code tab. English and Traditional Chinese interface.

## Highlights

### A clean, glanceable progress bar

- **In the status line, always.** `████░░░░ 27 min left` next to the `cache-timer` label, on by default, with no setup. Keep just `27 min left` if space is tight.
- **One row above the prompt.** On by default, and one click hides it. The bar goes from green to yellow to red as the cache runs down. Next to it: the time left, when auto-compact will run (only while it is on), and a Compact button. When the window narrows, the row drops its less important parts and never wraps.
- **Native in the desktop app.** The desktop app draws the bar as a smooth rounded SVG bar; the terminal uses block characters:

  ```
  Cache █████░░░░░ 28 min · auto-compacts 2 min before expiry [ Compact ] [ Pane ] ✕
  ```

### Built-in auto-compact

Claude Code's prompt cache expires after 5 minutes or 1 hour of inactivity. The next message after that re-writes the whole context to the cache, which costs more than ordinary input. On a long session, that is the most expensive message you send.

Turn on auto-compact and the mod compacts the conversation 1, 2 or 5 minutes before the cache expires, **while it is still warm**. Your next message then re-caches a short summary instead of the full transcript.

```
/cache auto 100k
```

Auto-compact is off by default, because compaction drops detail. It only fires when Claude is idle, at most once per cache window, and only on a context at least as large as the threshold you pick: 50k, 100k, 200k or 500k tokens (`/cache auto on` uses 100k). Prefer to decide yourself? The **Compact** button does the same thing with one click.

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

**Requirements:** a Claude Code build with function-hook mods (an early-access API). Tested on Claude Code 2.1.300 in the terminal and in the desktop app.

## All features

- **Status line countdown.** Whole minutes until the last 5 minutes, then `mm:ss`, or `expired`. Shows a bar and the time by default; switch to the time alone, or off.
- **Band above the prompt.** On by default; hide it with its ✕ (**Hide** in the desktop app) or `/cache band off`. After the cache expires, it says how many tokens the next message re-writes. Its **Pane** button opens the `/cache` pane and stays lit while the pane is open; press it again to close the pane.
- **`/cache` pane.** The time left and a Compact button, the last read and write sizes, and how many tokens an expiry would re-write. Below them, the settings fold away under **▸ Settings**; open them and each is a row of buttons with the current value highlighted (auto-compact is a dropdown). The pane remembers whether they are open.

  <img src="docs/images/pane-desktop.png" alt="The /cache pane: time left, last read and write, and settings" width="400">
- **Expiry reminders.** A toast 5 minutes before a 1h cache expires (1 minute before a 5m one), and another when it has expired.
- **Auto-compact.** Off by default. Pick off or a context threshold from a dropdown; compacts 1, 2 or 5 minutes before expiry, while the cache is still warm.
- **One-click compact.** From the band or the pane. The button reads `Compacting…` until the compaction ends, and the band then says the next message writes a fresh cache.
- **Automatic TTL detection.** The TTL starts at 1h and corrects itself from what the API reports. A cache read after more than 5 minutes proves 1h. A full re-write after 5 to 55 minutes proves 5m. A model switch also reports the TTL directly. Detection is the **auto** setting; pick 5m or 1h to fix the TTL instead.
- **Survives restarts.** Reopening the app or resuming a session picks the countdown up right away.
- **English or Traditional Chinese.** See [Language](#language).

## Usage

The countdown appears in the status line after your first message. Everything else lives in `/cache`:

| Command | What it does |
| --- | --- |
| `/cache` | Open the pane. Where no pane can be placed, prints the same figures. |
| `/cache auto 50k\|100k\|200k\|500k\|off` | Turn auto-compact on from that context size, or off (`on` keeps the current size) |
| `/cache ahead 1m\|2m\|5m` | How long before expiry auto-compact runs |
| `/cache ttl auto\|5m\|1h` | Detect the TTL, or fix it at 5m or 1h |
| `/cache status bar` / `time` / `off` | Show a bar and the time left in the status line (the default), the time alone, or nothing |
| `/cache band on` / `off` | Show or hide the band above the prompt (on by default) |
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
- **After a restart.** The timer is saved as it changes (for the 20 most recent sessions). A session last used before 0.3, or a fork, has nothing saved; its countdown is estimated from when the transcript's last response came in, and the pane shows only its context size.
- **Auto-compact rules.** Auto-compact only fires when Claude is idle, at most once per cache window, and only when the context reaches the threshold you picked (100k if you turn it on with `/cache auto on`). Below it, a summary saves too little to be worth the detail it drops. On a 5m cache it compacts at most 1 minute ahead, whatever **Compact ahead by** says, so a pause shorter than 4 minutes never triggers a compaction.
- **Compacting in the desktop app.** The desktop app (and any SDK or `-p` session) can't compact from a mod directly, so the Compact buttons run `/compact` there, which shows its own result in the transcript.
- **Resets.** Any compaction, whether `/compact`, Claude Code's own auto-compact, or this mod's, replaces the cached prefix. The timer then waits for the next message.

## Privacy and permissions

- **Nothing leaves your machine.** The mod makes no network requests. Of each model response it reads only the token counts (cache read, cache write, uncached input), never the text. The `http://www.w3.org/2000/svg` in the code is the SVG namespace of the bar, not an address it calls, and the mod reads no credentials or environment variables.
- **Notifications.** Its only output is on screen: the status line, the band, the pane, and the expiry reminders, shown as in-app toasts and, in the terminal, as a system notification. They carry the reminder text and token counts, nothing else.
- **The command it runs.** In the desktop app and in SDK or `-p` sessions, the Compact buttons and auto-compact run `/compact`, and only `/compact`: when you press a button, or, with auto-compact on, when Claude is idle shortly before the cache expires. In the terminal it compacts through Claude Code's own compaction call instead.
- **Hooks.** It watches `turn.start`, `turn.step`, `turn.complete`, `session.start`, `session.compact`, `ui.close` (to see the pane close), the resume and model-switch events, its own `/cache` command, and the `AbovePrompt` slot and its own pane. It passes every event on unchanged; it only reads the token counts, the reported cache TTL, and whether a compaction happened.
- **Stored data.** Its settings, and the timer of the 20 most recent sessions, are kept in Claude Code's local plugin store.

The `.github/` folder is this repository's CI, which releases new versions. It isn't part of the plugin at run time.

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
