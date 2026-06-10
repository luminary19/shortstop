---
name: shortstop
description: >-
  Turn a raw recording into a ready-to-post 9:16 YouTube Short, hands-off.
  Use when the user asks to edit a raw video, make a short, polish this clip,
  cut filler/dead air from a recording, caption a clip, or when a clip has been
  dropped into input/. One raw clip in, one polished vertical mp4 out.
---

# Shortstop — orchestration playbook

You (Claude) are the orchestrator. The deterministic stages are subprocess tools you
run; you apply judgment in exactly two places: **cut decisions** (step 6) and **QA gap
fixes** (step 9). No script ever calls an LLM.

Conventions for every command below:
- `SKILL` = this skill's folder (where this SKILL.md lives). `node` ≥ 20 required.
- Workspace dirs `input/ output/ reference/ runs/` live in the **host project CWD** —
  create them if missing.
- Stage scripts print one summary line on success and a clear message on failure;
  surface failures to the user verbatim, never a stack trace.
- Stream progress as you go (one short line per stage). First run downloads models:
  tell the user it's one-time setup.

## 0. Bootstrap (first run only)

If `SKILL/.shortstop-ready` is missing:

    node SKILL/scripts/bootstrap.mjs

Stream its output ("one-time setup, a few minutes"). If it fails, run
`node SKILL/scripts/doctor.mjs` and present its actionable report; stop.

## 1. Fail fast on prerequisites

Before any heavy work: `reference/` (host CWD) must contain at least one video clip —
the style exemplar required by QA. If it's empty or missing, **abort now** and tell the
user: "Add one finished Short you like as a style exemplar to `reference/` (e.g.
`reference/style.mp4`) and invoke me again."

## 2. Resolve the target clip and create the run dir

- Target = the file the user named, else the **newest video file in `input/`**.
  None found → tell the user to drop a clip into `input/`.
- Run id = `YYYYMMDD-HHmmss-<4 random chars>`; run dir = `runs/<run-id>/`.

## 3. Stage 0 — probe

    node SKILL/scripts/probe.mjs <clip> <runDir>

Exit 2 = rejected (over 20 min, no video/audio stream): surface the one-line message
verbatim and stop.

## 4. Stages 1–3 — transcribe, silence, track (independent; run in parallel)

    node SKILL/scripts/transcribe.mjs <runDir>
    node SKILL/scripts/silence.mjs <runDir>
    node SKILL/scripts/track.mjs <runDir>        # skip when config aspect.mode == "source"

(Each reads `probe.json`; they may run concurrently. Transcription is the slow one —
roughly real-time on CPU.)

## 5. Stage 4 — cut decisions (YOUR judgment)

Read `SKILL/prompts/cut_decisions.md` and follow it exactly: read
`<runDir>/transcript.json` + `<runDir>/silence.json` + the merged config (defaults at
`SKILL/config/default.config.json`, overridden by `<cwd>/shortstop.config.json` if
present), decide keeps/removals, and write your draft to `<runDir>/edl_draft.json`. Then:

    node SKILL/scripts/build_edl.mjs <runDir> <runDir>/edl_draft.json

Exit 3 prints machine-readable rejection reasons: repair your draft and resubmit —
**max 2 repairs**, then abort and show the validator's message.

## 6. Optional review gate

If the user passed `--review-edl` or asked to review the cuts: present the removed
segments as a table (timestamp range, kind, reason) plus the kept/removed totals from
`edl.json.stats`, and wait for approval before rendering.

## 7. Stages 5–6 — captions and render

    node SKILL/scripts/build_captions.mjs <runDir>    # skip if captions.enabled == false
    node SKILL/scripts/render.mjs <runDir> --attempt 0

Render failures (post-render assertions) are stage failures: read the message, fix the
cause (usually EDL/render mismatch), re-run. They are not QA gaps.

## 8. Stage 7 — QA measure

    node SKILL/scripts/qa.mjs <runDir> --attempt 0 --reference-dir reference

Exit 0 = pass → go to step 10. Exit 4 = gaps → step 9.

## 9. QA loop (YOUR judgment, bounded)

Follow `SKILL/prompts/qa_gap_fix.md`. Loop semantics (mirror `lib/qaloop.mjs` exactly):

- Track the **best** report (highest score). Order gaps hard-first, largest deviation
  first; fix **one** gap per attempt — deterministic remediations before judgment.
- After each fix: re-render (`render.mjs --attempt N` — pass B re-runs automatically
  when the EDL is unchanged; captions regenerate only if the EDL changed) and re-measure
  (`qa.mjs --attempt N`). Every fix gets measured — never produce a fix you don't render.
- `max_fix_attempts` = 5 (config). Stop early after **2 consecutive** attempts without a
  score improvement.

## 10. Deliver and report

    node SKILL/scripts/deliver.mjs <runDir> output --attempt <bestAttempt>

- pass → mp4 in `output/`; soft gaps only → mp4 + `*.QA_REPORT.md`; any hard gap →
  exit 5, report only, **no mp4** — tell the user plainly what blocked delivery and
  where the best candidate lives in `runs/`.
- Then summarize for the user: number of cuts, time removed by kind
  (from `edl.json.stats`), final duration, output path, and any QA notes.
- `deliver.mjs` prunes `runs/` to `config.runs.keep_last` automatically on success.
