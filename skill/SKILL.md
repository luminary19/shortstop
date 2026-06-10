---
name: shortstop
description: >-
  Turn a raw recording into ready-to-post video, hands-off. Two modes: shorts
  (idea-centered ≤60s 9:16 phone clips, several per source) and longform (full
  edit of the whole recording at 1920x1080). Use when the user asks to edit a
  raw video, make a short, clip a long video into shorts, polish this clip, cut
  filler/dead air from a recording, caption a clip, or when a clip has been
  dropped into input/.
---

# Shortstop — orchestration playbook

You (Claude) are the orchestrator. The deterministic stages are subprocess tools you
run; you apply judgment in exactly three places: **idea segmentation** (shorts mode,
step 6), **cut decisions** (step 7) and **QA gap fixes** (step 10). No script ever
calls an LLM.

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
user: "Add one finished clip you like as a style exemplar to `reference/` (e.g.
`reference/style.mp4`) and invoke me again."

## 2. Choose the mode

If the user's request doesn't already make it unambiguous, ask (AskUserQuestion):

- **Shorts** — find the self-contained ideas in the recording and deliver one polished
  ≤60 s vertical 720×1280 clip per strong idea. For phone-first platforms.
- **Longform** — edit the whole recording as one piece (cut fillers, dead air, retakes;
  captions; loudness) and deliver a single 1920×1080 horizontal video.

Mentions like "make shorts / clips for TikTok/YouTube Shorts" ⇒ shorts; "edit this
video / clean up this recording / full edit" ⇒ longform. When in doubt, ask.

## 3. Resolve the target clip and create the run dir

- Target = the file the user named, else the **newest video file in `input/`**.
  None found → tell the user to drop a clip into `input/`.
- Run id = `YYYYMMDD-HHmmss-<4 random chars>`; run dir = `runs/<run-id>/`.
- Write the mode into `runs/<run-id>/config.overrides.json`:

      { "mode": "shorts" }   // or "longform"

  Every stage script merges this over the defaults and `<cwd>/shortstop.config.json`
  automatically (mode presets: shorts ⇒ 9:16 @ 720×1280, 60 s hard cap; longform ⇒
  16:9 @ 1920×1080, no cap). Put any other per-run tweaks the user asked for in the
  same file.

## 4. Stage 0 — probe

    node SKILL/scripts/probe.mjs <clip> <runDir>

Exit 2 = rejected (over 60 min, no video/audio stream): surface the one-line message
verbatim and stop.

## 5. Stages 1–3 — transcribe, silence, track (independent; run in parallel)

    node SKILL/scripts/transcribe.mjs <runDir>
    node SKILL/scripts/silence.mjs <runDir>
    node SKILL/scripts/track.mjs <runDir>        # 9:16 (shorts) only — skip in longform/source mode

(Each reads `probe.json`; they may run concurrently. Transcription is the slow one —
roughly real-time on CPU.)

## 6. Shorts mode only — idea segmentation (YOUR judgment)

Read `SKILL/prompts/idea_segmentation.md` and follow it exactly: read the transcript
as prose, identify the self-contained ideas worth a Short (never naive equal-length
chopping), write your draft to `<runDir>/ideas_draft.json`. Then:

    node SKILL/scripts/segment_ideas.mjs <runDir> <runDir>/ideas_draft.json

Exit 3 prints machine-readable rejection reasons: repair and resubmit — **max 2
repairs**, then abort with the validator's message. On success it writes `ideas.json`
and creates one `clip<N>/` workspace per idea (shared artifacts copied in).

Tell the user the idea list (title, span, strength). Then run steps 7–10 **once per
clip dir**, using `<runDir>/clip<N>` as the run dir everywhere below. Finish every
clip; report per-clip results at the end.

**Longform mode**: skip this step; run steps 7–10 once with `<runDir>` itself.

## 7. Stage 4 — cut decisions (YOUR judgment)

Read `SKILL/prompts/cut_decisions.md` and follow it exactly: read
`<runDir>/transcript.json` + `<runDir>/silence.json` + the merged config, decide
keeps/removals (in an idea clip, only within the idea's span), and write your draft to
`<runDir>/edl_draft.json`. Then:

    node SKILL/scripts/build_edl.mjs <runDir> <runDir>/edl_draft.json

Exit 3 prints machine-readable rejection reasons (including `too_long` when the kept
duration exceeds the 60 s shorts cap): repair your draft and resubmit — **max 2
repairs**, then abort and show the validator's message.

## 8. Optional review gate

If the user passed `--review-edl` or asked to review the cuts: present the removed
segments as a table (timestamp range, kind, reason) plus the kept/removed totals from
`edl.json.stats`, and wait for approval before rendering.

## 9. Stages 5–6 — captions and render

    node SKILL/scripts/build_captions.mjs <runDir>    # skip if captions.enabled == false
    node SKILL/scripts/render.mjs <runDir> --attempt 0

Render failures (post-render assertions) are stage failures: read the message, fix the
cause (usually EDL/render mismatch), re-run. They are not QA gaps.

## 10. Stage 7 — QA measure + bounded fix loop

    node SKILL/scripts/qa.mjs <runDir> --attempt 0 --reference-dir reference

Exit 0 = pass → deliver. Exit 4 = gaps → follow `SKILL/prompts/qa_gap_fix.md`. Loop
semantics (mirror `lib/qaloop.mjs` exactly):

- Track the **best** report (highest score). Order gaps hard-first, largest deviation
  first; fix **one** gap per attempt — deterministic remediations before judgment.
- After each fix: re-render (`render.mjs --attempt N` — pass B re-runs automatically
  when the EDL is unchanged; captions regenerate only if the EDL changed) and re-measure
  (`qa.mjs --attempt N`). Every fix gets measured — never produce a fix you don't render.
- `max_fix_attempts` = 5 (config). Stop early after **2 consecutive** attempts without a
  score improvement.

## 11. Deliver and report

    node SKILL/scripts/deliver.mjs <runDir> output --attempt <bestAttempt>

- pass → mp4 in `output/`; soft gaps only → mp4 + `*.QA_REPORT.md`; any hard gap →
  exit 5, report only, **no mp4** — tell the user plainly what blocked delivery and
  where the best candidate lives in `runs/`.
- Shorts multi-clip outputs are named `<stem>-<run-id>-clip<N>.mp4` automatically.
  One clip hard-failing QA does not block the others — deliver what passes, report
  what didn't.
- Then summarize for the user: per clip — number of cuts, time removed by kind
  (from `edl.json.stats`), final duration, output path, and any QA notes.
- `deliver.mjs` prunes `runs/` to `config.runs.keep_last` automatically on success.
