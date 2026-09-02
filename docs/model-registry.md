# Model registry — adding and swapping models

All model choices live in `models.config.yaml`. The pipeline, CLI, and eval
runner all read it. **You never edit pipeline code to change a model.**

## Anatomy

```yaml
stages:
  organize:
    default:                  # cheap lane, carries routine volume
      provider: openai-compatible
      model: gpt-5-mini
      params: { temperature: 0.2 }
    escalation:               # strong lane, used on low confidence / schema failure
      provider: anthropic
      model: claude-sonnet-5
```

`provider` selects the adapter in `packages/providers`:

| provider            | adapter                       | used for |
|---------------------|-------------------------------|----------|
| `openai-compatible` | chat/completions, /audio/*, /embeddings via the gateway | gpt-*, transcribe, embeddings, tts |
| `anthropic`         | /messages with forced tool call | claude-* |

## Swap a model

1. Edit the `model:` line. 2. Run `npm run eval`. 3. Compare the report in
   `packages/evals/reports/`. Keep the winner.

To compare two stacks properly, copy the config:
`DONNA_MODELS_CONFIG=./models.sonnet-first.yaml npm run eval`.

## Add a new provider (e.g. OpenRouter for the public product)

1. Add one file in `packages/providers/src/` implementing the port
   (`Organizer`, `Transcriber`, or `Embedder`).
2. Add its name to the `provider` enum in `packages/providers/src/registry.ts`
   and one `case` in the factory.
3. Reference it from a config. Done — pipeline untouched.

## Current catalog picks (Sep 2026 research)

| Stage | Default | Escalation | Why |
|---|---|---|---|
| transcribe | `gpt-4o-transcribe` | — | Only dedicated STT in the catalog; strong accent/noise WER. Request `gpt-4o-mini-transcribe` be added — half the cost. |
| organize | `gpt-5-mini` | `claude-sonnet-5` | Cheapest current-gen with solid structured outputs; Sonnet for the hard cases and demo quality. |
| embed | `text-embedding-3-large` @1024 dims | — | Only embedding in catalog; Matryoshka truncation keeps it cheap. |
| tts | `gpt-4o-mini-tts` | — | Optional demo voice confirmation. |

Deliberately rejected: `gpt-audio-1-5` as one-step STT+organizer (no
structured outputs, ~5× audio cost, breaks provenance); flagship models in
the loop (10–30× cost, no gain on extraction).
