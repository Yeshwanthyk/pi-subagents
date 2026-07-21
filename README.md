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

## Isolated interactive sessions

Other Pi extensions can create private, floating Pi sessions over the shared `pi.events` bus. These sessions are namespaced, excluded from `/subagents` and automatic result delivery, and can use an explicit tool allowlist.

Protocol channels (version 1):

- `subagents:interactive:ping`
- `subagents:interactive:spawn`
- `subagents:interactive:list`
- `subagents:interactive:open`
- `subagents:interactive:show`
- `subagents:interactive:close`

Every request includes a `requestId`; replies use `<channel>:reply:<requestId>`. Spawn supports fresh or parent-forked persisted Pi sessions. Floating sessions can be moved with `o` into the terminal host Pi currently runs inside: Herdr, cmux, or tmux. The in-process runtime is disposed before the external Pi process receives the session file.

`pi-btw` and `pi-handoff` use this API without appearing in the normal subagent UI.

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
