# pi-subagents

Local Pi package extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) for personal evaluation.

It provides headless Pi and Codex subagents with asynchronous result delivery, wait/check/cancel tools, and an interactive `/subagents` transcript/takeover UI.

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

## Commands

- `/subagents` — list, inspect, and take over parent-owned subagents

## Extension client API

Extensions can launch client-owned managed subagents through the versioned `subagents:client:*` event protocol. The channels are `ping`, `spawn`, `cancel`, `list`, `ready`, and `settled`. Requests use a `requestId`, `clientId`, and correlation data; replies use `<channel>:reply:<requestId>`. Client-owned jobs retain client API dedupe/list/cancel access and settlement events, but are deliberately omitted from parent tools and `/subagents` instead of being delivered into the parent conversation.

## Development

```sh
npm install
npm run check
npm test
```

Live Codex tests are separate because they use an authenticated external harness:

```sh
npm run test:live
```

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision. This repository is licensed under MIT; see [`LICENSE`](LICENSE).
