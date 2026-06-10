# Planned changes

(implemented 2026-06-10: mode question at skill start, shorts idea-segmentation with
multi-clip output, 60 s hard clip cap, 720×1280 shorts / 1920×1080 longform output,
60-min input cap, best-effort Windows support)

## Remaining

- **Windows validation** — code paths are OS-aware but have never executed on real
  Windows; run `node skill/scripts/bootstrap.mjs` + `npm test` on a Windows machine
  (or add a GitHub Actions windows-latest workflow) and fix what breaks.
- **CRF/bitrate sanity for upscaled low-res sources** — CRF 18 on a 480p→720p upscale
  still produces large files; consider source-aware CRF or a bitrate ceiling.
