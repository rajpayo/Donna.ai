# Donna.ai — Handoff Document

**Date:** 2026-09-02 · **From:** Cloud agent session on `rajpayo/Donna` (run bc-a4d4ac70) · **For:** Raj

This file describes everything built so far, why, and exactly how to take it from here.
Read it top to bottom once; section 6 is the paste-able context for your next session.

---

## 1. What exists right now

A complete, tested MVP scaffold for the **core loop** of Donna:

```
audio ─▶ transcribe ─▶ organize ─▶ embed ─▶ place in dynamic bucket ─▶ persist
```

- 47 files, TypeScript monorepo (npm workspaces, Node ≥ 20)
- Typecheck clean, **8/8 unit tests green** (no API keys needed for tests)
- Branch: `cursor/mvp-core-loop-scaffold-87cc`
- Currently staged as branch **`donna-ai-scaffold-transport`** on `rajpayo/Donna`
  (the agent's token could only write there — see section 5 to move it)

## 2. Product context (one paragraph)

Donna is a voice-first notes product for busy Microsoft-centric executives/managers:
speak messy thoughts between meetings → the system distills atomic thoughts → files
them into **dynamically created buckets** (no fixed taxonomy) → everything is
retrievable with **provenance** back to the exact spoken words. Commitments always
land in a special **Tasks** bucket — the hook for the future agent layer (section 7).
Business plan + model research live in `rajpayo/Donna` (`business-plan/`, and
`business-plan/research/model_selection_mvp.md`).

## 3. Architecture (the rules that matter)

1. **Ports & adapters** — `packages/core` holds domain types + interfaces
   (`Transcriber`, `Organizer`, `Embedder`, `BucketStore`). Vendor code lives only in
   `packages/providers`. Swapping a model or vendor never touches pipeline code.
2. **Models are config** — `models.config.yaml` is the ONLY place models are chosen.
   Each stage has a cheap `default` lane and a strong `escalation` lane (used on
   low confidence or schema failure). Routing logic lives in one file:
   `packages/pipeline/src/run.ts`.
3. **Dynamic buckets** — the organizer LLM *proposes* a placement; the engine
   *decides* via cosine similarity against bucket centroids
   (`assign_threshold` 0.82 / `create_threshold` 0.65 in config). No fit → a new
   bucket is minted on the spot, seeded with the thought's embedding. Task-bearing
   thoughts are hard-routed to the `Tasks` bucket (created on first use).
4. **Provenance is mandatory** — every thought links to transcript segment IDs +
   audio timestamps.
5. **Telemetry from request one** — every gateway call is tagged
   (app/tenant/stage via `x-tfy-metadata`) so TrueFoundry's dashboard gives
   cost-per-successful-core-loop.

## 4. Model decisions (researched 2026-09-02, company TrueFoundry catalog)

| Stage | Default | Escalation | Why |
|---|---|---|---|
| transcribe | `gpt-4o-transcribe` ($0.006/min) | — | Only dedicated STT in catalog; strong accent/noise WER. **Request `gpt-4o-mini-transcribe` be added — halves the dominant cost.** |
| organize | `gpt-5-mini` ($0.25/$2.00 per MTok) | `claude-sonnet-5` ($3/$15) | Cheapest current-gen with solid JSON-schema structured outputs; Sonnet for hard cases/demo quality. |
| embed | `text-embedding-3-large` @ 1024 dims ($0.13/MTok) | — | Only embedding in catalog; Matryoshka truncation keeps vectors cheap. |
| tts (optional) | `gpt-4o-mini-tts` (~$0.015/min) | — | Demo voice confirmation only. |

Rejected: `gpt-audio-1-5` as one-step STT+organizer (no structured outputs, ~5×
audio cost, breaks provenance); flagship models in the loop (10–30× cost, no gain
on extraction). Key economics: **STT ≈ 93% of per-user AI cost** (~$2.79/user/mo
total at 440 min/mo) — optimize transcription first, the LLM choice is quality
(not cost) driven. Full detail: `rajpayo/Donna` → `business-plan/research/model_selection_mvp.md`.

**Hard constraint:** the company TrueFoundry gateway is for INTERNAL demo/company
assets only. The public product must run on separate infrastructure (own vendor
accounts / OpenRouter cheap routes — the business plan's Phase-1/Phase-2 strategy).

## 5. Move this code into `rajpayo/Donna.ai` (your steps)

The scaffold is staged as branch `donna-ai-scaffold-transport` on `rajpayo/Donna`.
From your machine:

```bash
git clone https://github.com/rajpayo/Donna.ai.git
cd Donna.ai
git fetch https://github.com/rajpayo/Donna.git donna-ai-scaffold-transport:bootstrap
git checkout bootstrap
git checkout -b main
git push -u origin main
```

Then delete the transport branch on Donna when you're satisfied:
`git push https://github.com/rajpayo/Donna.git --delete donna-ai-scaffold-transport`

## 6. Paste this into your new Donna.ai session

> This repo is Donna.ai: a voice-first capture → dynamic-organization → retrieval
> product. The MVP core loop is scaffolded (transcribe → organize → embed →
> dynamic buckets) with a ports/adapters architecture; models are chosen only in
> models.config.yaml (default lane gpt-5-mini, escalation claude-sonnet-5, STT
> gpt-4o-transcribe, embeddings text-embedding-3-large@1024). Read HANDOFF.md,
> README.md, and docs/ first. Constraints: company TrueFoundry gateway is
> internal-demo only; provenance and tenant isolation are mandatory; sort quality
> is the moat. Next steps: (1) wire real gateway creds and run the CLI demo
> end-to-end on a real recording; (2) run the eval harness and grow the golden
> dataset from misfires; (3) build the OneNote destination adapter (validate the
> microsoft-365 MCP can create pages first); (4) later, the bucket-driven agent
> layer per docs/roadmap-agents.md (Tasks bucket → Asana agent with confirm/reject).

## 7. What's next (in order)

1. **Run the demo for real** — set `TRUEFOUNDRY_BASE_URL` / `TRUEFOUNDRY_API_KEY`
   in `.env`, then `npm install && npm run capture -- capture ./sample.m4a`.
2. **Eval loop** — `npm run eval`; every demo misfire becomes a labeled case in
   `packages/evals/datasets/golden/`. Model swaps are judged by report diffs in
   `packages/evals/reports/`.
3. **OneNote destination adapter** — buckets land on the page; validate the
   microsoft-365 MCP's OneNote write capability first (source-gap SG-02).
4. **Agent layer** — see `docs/roadmap-agents.md`: buckets as agent work queues;
   first agent = Tasks → Asana with assignee confirm/reject and write-back.

## 8. Repo map

```
Donna.ai/
├── HANDOFF.md               # this file
├── models.config.yaml       # the ONE place models are chosen/swapped
├── docs/
│   ├── architecture.md      # design rules and the why
│   ├── model-registry.md    # how to add/swap models and providers
│   ├── evals.md             # the iterate-to-perfection loop
│   └── roadmap-agents.md    # bucket-driven agents (vision + hard rules)
├── packages/
│   ├── core/                # domain types + ports (no vendor code)
│   ├── providers/           # gateway client, OpenAI/Anthropic adapters, registry
│   ├── buckets/             # dynamic bucket engine + file store (+ tests)
│   ├── pipeline/            # orchestration + default/escalation routing
│   └── evals/               # golden dataset, scorers, runner, reports (+ tests)
└── apps/cli/                # demo CLI: capture / buckets commands
```
