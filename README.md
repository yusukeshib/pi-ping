# pi-ping

An opt-in Pi extension that sends periodic wake-up messages when the agent is idle, starting another agent turn. **Disabled by default**, with a **5-minute** default interval.

## Installation

After the package is published:

```sh
pi install npm:@yusukeshib/pi-ping
```

For local development, install the checkout instead:

```sh
pi install /path/to/pi-ping
```

Run `/reload` in Pi after installation. Tested with Pi 0.99.2.

## Commands

| Command | Behavior |
| --- | --- |
| `/ping enable` | Enable with the current interval (initially 5 minutes) |
| `/ping enable 2m` | Enable with a 2-minute interval |
| `/ping interval 30s` | Change the interval without enabling or disabling |
| `/ping disable` | Disable immediately and cancel the timer |
| `/ping status` or `/ping` | Show status, interval, and time until the next check |

Durations accept `s` (seconds), `m` (minutes), and `h` (hours). Bare numbers are minutes: `5` means 5 minutes. Fractional values such as `0.5m` work too. The range is 1 second to 24 hours; 5 minutes is recommended for normal use.

## Behavior

- Waits a full interval after enabling or after `agent_settled`, when Pi has finished all automatic work. It does not wake on `agent_end`, so it does not interrupt Pi's built-in retries or automatic compaction.
- Does not send while the agent is busy, messages are queued, an extension dialog is open, or the TUI editor contains a draft. Checks again after another interval.
- Displays a distinct `pi-ping` custom message rather than impersonating user input. The message asks the agent to continue unfinished authorized work or retry after a transient network failure. It explicitly discourages inventing work, repeating completed side effects, bypassing approvals, or ignoring a request to stop.
- Uses at most one timer. Cancels it when a run starts and restarts it after settlement. Disable, shutdown, session replacement, and reload clean up the old timer.
- Saves enabled state and interval on the session's active branch. Resume, reload, and forks that inherit the saved state restore those settings. New sessions start disabled. Navigating with `/tree` restores the destination branch's settings.

## Important limitations

**While enabled, pi-ping starts model turns even after work is complete or after an Esc interruption. This can consume tokens and incur charges. Use `/ping disable` to stop it.**

This extension does not restore network connectivity. If a network failure ends Pi's run and leaves it idle, the extension attempts another model turn after the configured interval. If the network is still unavailable, that turn can fail again; another check follows after the failed run settles.

It cannot recover an exited Pi process, wake a sleeping operating system, unblock a frozen event loop, or interrupt a hung run that never returns to idle. It is not a watchdog that forcibly aborts operations. Whether work actually resumes depends on the conversation, permissions, model, and connectivity.

## Development and validation

```sh
npm ci --ignore-scripts
npm run check
npm run smoke
npm pack --dry-run
```

`check` runs TypeScript checks and 10 fake-timer tests. `smoke` requires an installed `pi` command and Python 3. It runs Pi's actual RPC lifecycle with isolated settings and a deterministic local provider, verifying simulated network failure, wake-up, recovery, and disable. It makes two local mock calls, no external model calls, and incurs no API charges. Actual network outages and long-running real-model continuation have not been tested.

## Publishing to npm

The initial release is **0.1.0**. Do not bump the version before the first publication.

```sh
npm run release:dry-run
npm run release
```

`release` publishes to npm. The `prepublishOnly` hook runs type checks and tests first. `publishConfig` selects the official npm registry and public access. Follow npm's CLI instructions if authentication or two-factor verification is required. Run `npm run smoke` separately before publishing when needed.

Only `extensions/`, `README.md`, `LICENSE`, and `package.json` are included in the package. After the initial publication, subsequent releases require a new version: npm does not allow republishing the same version.

## Uninstallation

```sh
pi remove npm:@yusukeshib/pi-ping
```

For a local checkout, use `pi remove /path/to/pi-ping` instead. Then run `/reload`.
