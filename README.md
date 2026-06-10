# Shortstop

A Claude Code skill that turns a raw recording into a ready-to-post **9:16 YouTube
Short**, hands-off. Drop a clip in `input/`, invoke the skill, get a polished vertical
`.mp4` with word-level karaoke captions back a few minutes later.

Claude orchestrates; deterministic scripts do the work (probe → transcribe → silence →
track → cut → captions → render → QA). Everything runs locally — no API keys, no cloud,
no GPU. Linux only.

## Quickstart

Prereqs: **Node ≥ 20** and **python3 ≥ 3.9** (with `venv`). Everything else
(static ffmpeg, faster-whisper, OpenCV/YuNet, fonts, models) bootstraps itself.

```bash
# 1. install the skill into your project (or ~/.claude/skills/ for all projects)
cp -r skill/ <your-project>/.claude/skills/shortstop/

# 2. in your project: add a style exemplar (any finished Short you like)
mkdir -p reference input
cp some-short-you-like.mp4 reference/

# 3. drop your raw clip and invoke
cp my-raw-take.mp4 input/
claude  # then: "/shortstop" or "make a short from input/my-raw-take.mp4"
```

First invocation runs one-time setup (npm deps, python venv, Whisper + YuNet models —
a few minutes). After that: clip in, Short out in `output/<name>-<run-id>.mp4`,
intermediates in `runs/<run-id>/`.

### What it does to your clip

- removes filler words, long pauses, false starts, and abandoned retakes
  (cuts always land inside detected silence — no clipped syllables)
- reframes to 1080×1920 with face tracking (blur-pad fallback for screen recordings)
- burns word-level karaoke captions (config-disableable)
- normalizes audio to −14 LUFS, true peak ≤ −1 dBTP, click-free junctions
- QA-checks the result and fixes its own defects (bounded, ≤ 5 attempts);
  a clip with unresolved hard defects is never delivered silently

### Config

Defaults live in `skill/config/default.config.json`; override any subset in
`<project>/shortstop.config.json`. Highlights: `whisper.model` (`base` for weak
machines), `captions.*` (style/off), `aspect.mode: "source"` (skip reframing),
`cut.target_duration_s`, `audio.track` (OBS multi-track: `"mix"` or a stream index).

Tips: source ≥ 1440p makes the 9:16 crop native-sharp (1080p sources are upscaled
~1.8×); raw inputs over 20 minutes are rejected by design.

Want to see the cut list before rendering? Ask for `--review-edl`.

## Dev workspace

```bash
npm install               # root: links skill/ + hoists deps
node tests/fixtures.mjs   # generate deterministic fixtures (espeak-ng + ffmpeg)
npm test                  # full per-stage + e2e suite (~5 min, CPU whisper)
```

`skill/` is the distributable; `tests/` never ships. See `PLAN.md` for the full spec
and decision record.
