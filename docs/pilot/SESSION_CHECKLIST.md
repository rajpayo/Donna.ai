# Pilot session checklist

Specification 6.2. One checklist per pilot session (a sitting in which a
participant runs one or more scenarios).

## Before the session

- [ ] Participant is enrolled (`donna pilot status` shows `enrolled`).
- [ ] Consent state matches the participant's choices (`donna consent list`).
- [ ] No HR/legal/financial/KYC/payment content will be captured.
- [ ] Microsoft 365 sources are as the participant chose
      (`donna m365 connect-info`).
- [ ] Audio key and gateway credentials are present (run
      `donna compat-check` when in doubt).
- [ ] A working microphone and a quiet-enough room (unless the scenario
      calls for noise, V-NOISE).
- [ ] Terminal is private if transcripts will be shown
      (default output is redacted; `--show-transcripts` is for private
      terminals only).

## During the session

- [ ] Open the run: `donna pilot run start --scenario <SC-ID>`.
- [ ] Capture with `donna capture <recording>` (bind a session with
      `--session <id>` when the scenario involves emotion context).
- [ ] Work the review queue: `donna pilot review`.
- [ ] Record every explicit decision through the commands in the runbook
      mapping table (moves, edits, approvals, rejections, retrieval
      feedback).
- [ ] Report every misfire the moment it happens:
      `donna pilot report-misfire <category> --description "…"`.
- [ ] Note variants (accent/pace/noise/interruption/correction/repeat) for
      the run notes.

## After the session

- [ ] Close the run: `donna pilot run end <run-id> --notes "<variants, context>"`.
- [ ] End any open Donna session: `donna session end <session-id>`
      (session emotion/working memory dies with it).
- [ ] Triage new misfires with the product owner:
      `donna pilot misfire triage …` then `… resolve …`.
- [ ] If a fix deserves a shared golden case AND the participant consents:
      `donna pilot misfire promote <id> --correction <id>`.
- [ ] Check the board: `donna pilot misfire board` — note unresolved and
      blocking items.
- [ ] Weekly: retention spot-check (`donna retention --cleanup`) and an
      export spot-check (`donna pilot export --out <file>`).
