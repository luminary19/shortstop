# Planned changes

- **Built-in Windows support** — run the skill natively on Windows (paths, venv bootstrap, ffmpeg binaries) instead of assuming Linux.
- **Idea judgment stage (clip by ideas)** — new clipper mode that segments a long video into multiple self-contained, idea-centered clips, each getting its own EDL → captions → render → QA pass. Probe/transcript/silence/track artifacts are already full-source and can be shared across clips.
- **Clip max time limit** — hard cap on output clip length (distinct from the soft `cut.target_duration_s` and the QA-only `qa.shorts_max_s`).
- **Clip/video target resolution** — configurable output resolution per run (currently fixed at 1080×1920 via `aspect.out_width`/`out_height`; should also reconsider CRF 18 for upscaled low-res sources — 480p input produced a 420 MB output).
