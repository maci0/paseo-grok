# Grok

Resume a Grok Build session from this machine in Paseo.

Import session lists `~/.grok/sessions` (or `$GROK_HOME`). Choosing a row starts `grok agent --no-leader stdio` and loads that session id, so the next prompt continues the native Grok session. Paseo shows the last 600 updates from `updates.jsonl` because Grok's ACP `session/load` does not replay the transcript.

The provider id is `grok`. A session that is open in the Grok TUI can fail to load until that process releases it.

A message sent while a turn is running is injected into that turn.
