# pi-subagents

Local Pi package extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) for personal evaluation.

It provides headless Pi, Claude Code, and Codex subagents with asynchronous result delivery, wait/check/cancel tools, an interactive `/subagents` transcript/takeover UI, and persistent read-only BTW side conversations.

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

- `/subagents` — list, inspect, and take over standard subagents
- `/btw <question>` — open a persistent read-only side conversation
- `/btw-sessions` — list and reopen BTW sessions

## BTW side conversations

BTW sessions fork the active persisted parent conversation, inherit its model and thinking level, and receive only the read/research tools `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, and `get_search_content`. They use private visibility and no parent result delivery, so they do not appear in `/subagents` or inject answers into the parent thread.

Inside Herdr, `/btw` prepares the fork and launches it directly in a focused Herdr tab before the first turn. Elsewhere it opens the floating takeover UI; pressing `o` can move a settled session into Herdr, cmux, or tmux. `/btw-sessions` restores persisted session records, reopens live floating sessions, and focuses external sessions.

## Extension client API

Extensions can launch standard managed subagents through the versioned `subagents:client:*` event protocol. The channels are `ping`, `spawn`, `cancel`, `list`, `ready`, and `settled`. Requests use a `requestId`, `clientId`, and correlation data; replies use `<channel>:reply:<requestId>`. Client-owned settlements are emitted on `subagents:client:settled` instead of being delivered into the parent conversation.

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
