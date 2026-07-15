# pi-subagents

Local Pi package extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) for personal evaluation.

It provides headless Pi, Claude Code, and Codex subagents with asynchronous result delivery, wait/check/cancel tools, and an interactive `/subagents` transcript/takeover UI.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-subagents
```

Reload an existing Pi session with `/reload`.

## Tools

- `subagent_spawn`
- `subagent_wait`
- `subagent_cancel`
- `subagent_check`
- `subagent_list`
- `/subagents`

## Development

```sh
npm install
npm run check
npm test
```

Live Claude/Codex tests are separate because they use authenticated external harnesses:

```sh
npm run test:live
```

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision, so this repository is intentionally private/local and marked `UNLICENSED`.
