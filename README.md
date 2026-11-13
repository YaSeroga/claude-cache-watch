# cache-watch

A Claude Code mod that tells you when the next message will be expensive.

Claude Code sends the full conversation with each message. Anthropic keeps a prompt cache for a limited time, and a cached message costs much less. When the cache expires, or when the context becomes very large, each message costs more. This mod shows a card above the prompt in these conditions, and stays out of view at all other times.

## Install

At the prompt of a terminal session:

```
/plugin install cache-watch --marketplace YaSeroga/claude-cache-watch
```

Answer `y` to add the marketplace, then select a scope.

From a shell:

```
claude plugin install cache-watch --marketplace YaSeroga/claude-cache-watch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `YaSeroga/claude-cache-watch`, then Add plugin.

## What it shows

| State | Card | Buttons |
|---|---|---|
| The cache is expired and the context is above 50k tokens | Blue: "Prompt cache expired. The next message sends all 182k tokens at the full price." | Hide |
| The context is at 500k tokens or more | Amber: "Context: 512k tokens", with a hint to think about a handover | Write handover, Hide |
| The context is at 700k tokens or more | Red: "Context: 712k tokens. A new session is recommended." | Write handover, Hide |

On the desktop app the card has a ring gauge with marks at the two limits. The terminal shows a text meter.

**Write handover** puts a prompt in the prompt box. The prompt tells Claude to write a handover document and to propose a new session with it. You can edit the prompt before you send it. Where the mod cannot fill the prompt box, the card opens an editable field of its own.

**Hide** removes the card until the cache expires again or the context grows by 100k more tokens.

## Demo

```
/cache-watch-demo
```

This command shows all three cards at once with sample values. The buttons are real. Run the command again to close the demo.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cacheTtlMinutes` | 60 | How long the prompt cache stays after the last request. Use 5 when the session is in usage overage. |
| `infoTokens` | 500000 | The context size for the amber card. |
| `warnTokens` | 700000 | The context size for the red card. |

## Limits

- The cache state is an estimate. Anthropic does not report that a cache entry is gone. The mod starts a timer at the end of each turn.
- The card does not show a cache loss from a model switch or a compaction.
- A resumed session shows nothing until its first response.
- The default limits never trigger on a model with a 200k context window. Lower them in the settings.

## Development

```
claude plugin validate .
```

```
claude plugin test .
```
