# Shortstop

A Claude Code skill that turns a raw recording into ready-to-post video, hands-off.
Drop a clip in `input/`, invoke the skill, pick a mode, get polished `.mp4`(s) with
word-level karaoke captions back a few minutes later.

Two modes:

- **Shorts** — finds the self-contained ideas in the recording (no naive equal-length
  chopping) and delivers one vertical **720×1280** clip per strong idea, each hard-capped
  at **60 s**, with face-tracked 9:16 reframing.
- **Longform** — edits the whole recording as one piece and delivers a single horizontal
  **1920×1080** video (no reframing crop; blur-pad if the source isn't 16:9).

Claude orchestrates; deterministic scripts do the work (probe → transcribe → silence →
track → [ideas] → cut → captions → render → QA). Everything runs locally — no API keys,
no cloud, no GPU. Linux is the tested platform; Windows support is best-effort (OS-aware
bootstrap/venv/ffmpeg paths, not yet CI-verified).

## Quickstart

Prereqs: **Node ≥ 20** and **Python ≥ 3.9** (with `venv`; on Windows the `py` launcher
or `python` on PATH). Everything else (static ffmpeg, faster-whisper, OpenCV/YuNet,
fonts, models) bootstraps itself.

```bash
# 1. install the skill into your project (or ~/.claude/skills/ for all projects)
cp -r skill/ <your-project>/.claude/skills/shortstop/

# 2. in your project: add a style exemplar (any finished clip you like)
mkdir -p reference input
cp some-clip-you-like.mp4 reference/

# 3. drop your raw clip and invoke
cp my-raw-take.mp4 input/
claude  # then: "/shortstop" — it asks shorts vs longform if your request is ambiguous
```

First invocation runs one-time setup (npm deps, python venv, Whisper + YuNet models —
a few minutes). After that: clip in, output in `output/<name>-<run-id>.mp4`
(shorts mode: `output/<name>-<run-id>-clip<N>.mp4`, one per idea), intermediates in
`runs/<run-id>/`.

### What it does to your clip

- **shorts mode**: reads the transcript as prose and segments by *ideas* — each output
  clip is a complete thought (setup → point → payoff) that works standalone
- removes filler words, long pauses, false starts, and abandoned retakes
  (cuts always land inside detected silence — no clipped syllables)
- shorts: reframes to 720×1280 with face tracking (blur-pad fallback for screen
  recordings), ≤ 60 s enforced at the EDL level; longform: 1920×1080
- burns word-level karaoke captions, scaled to the output resolution (config-disableable)
- normalizes audio to −14 LUFS, true peak ≤ −1 dBTP, click-free junctions
- QA-checks the result and fixes its own defects (bounded, ≤ 5 attempts);
  a clip with unresolved hard defects is never delivered silently

### Config

Defaults live in `skill/config/default.config.json`; mode presets (shorts/longform)
apply on top, then any subset you override in `<project>/shortstop.config.json`, then
per-run overrides in `runs/<id>/config.overrides.json` (written by the orchestrator).
Highlights: `mode`, `whisper.model` (`base` for weak machines), `captions.*`
(style/off), `aspect.*` (resolution, `"source"` to skip reframing), `cut.max_clip_s`
(hard cap), `cut.target_duration_s` (soft target), `audio.track` (OBS multi-track:
`"mix"` or a stream index).

Tips: raw inputs over 60 minutes are rejected by design; transcription is roughly
real-time on CPU, so an hour of input costs about an hour.

Want to see the cut list before rendering? Ask for `--review-edl`.

## Dev workspace

```bash
npm install               # root: links skill/ + hoists deps
node tests/fixtures.mjs   # generate deterministic fixtures (espeak-ng + ffmpeg)
npm test                  # full per-stage + e2e suite (~5 min, CPU whisper)
```

Fixture generation needs `espeak-ng` on PATH (Linux: `apt install espeak-ng`;
Windows: `winget install eSpeak-NG.eSpeak-NG`).

`skill/` is the distributable; `tests/` never ships. See `PLAN.md` for the full spec
and decision record.
