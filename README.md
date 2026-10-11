# grok

Paseo provider plugin that lists Grok Build sessions on disk and resumes them over ACP.

`grok agent stdio` can `session/load` a TUI session, and `session/list` returns rows, but load does not stream the conversation. Paseo's ACP importer hides a row when load produces no conversation, so those sessions never appear. This provider reads `summary.json` for the picker and `updates.jsonl` for the transcript, then loads the same id so Grok keeps the real context.

```bash
bun install
bun test
bunx tsc --noEmit
```

Install the directory with `paseo plugin install` using an absolute path. The provider id is `grok`. Do not add an `agents.providers.grok` entry. A config provider with that id hides this one, and `enabled: false` still leaves the row in the provider list.

Plugins are unsandboxed. The daemon has to be started with plugins enabled before this provider runs.
