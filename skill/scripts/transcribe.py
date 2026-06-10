#!/usr/bin/env python3
"""Stage 1 — faster-whisper transcription.

Usage: transcribe.py <wav_16k_mono> <out_json> --model <size-or-dir> [--language auto]

Emits transcript.json per schema: word-level timestamps mandatory, word
probability preserved so Stage 4 can treat low-confidence regions cautiously.
"""
import argparse
import json
import os
import sys
import wave


def wav_duration(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out_json")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="auto")
    args = ap.parse_args()

    duration = wav_duration(args.wav)

    from faster_whisper import WhisperModel

    model_ref = args.model if os.path.isdir(args.model) else args.model
    model = WhisperModel(model_ref, device="cpu", compute_type="int8")

    language = None if args.language == "auto" else args.language
    segments_iter, info = model.transcribe(
        args.wav,
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    clamp = lambda t: max(0.0, min(float(t), duration))
    segments = []
    for i, seg in enumerate(segments_iter):
        words = [
            {
                "word": w.word.strip(),
                "start": clamp(w.start),
                "end": clamp(w.end),
                "prob": max(0.0, min(float(w.probability), 1.0)),
            }
            for w in (seg.words or [])
            if w.word.strip()
        ]
        if not words:
            continue
        segments.append(
            {
                "id": len(segments),
                "start": clamp(seg.start),
                "end": clamp(seg.end),
                "text": seg.text.strip(),
                "words": words,
            }
        )

    out = {
        "language": info.language or "unknown",
        "duration_s": duration,
        "segments": segments,
    }
    with open(args.out_json, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(
        f"transcribed {duration:.1f}s -> {len(segments)} segments, "
        f"{sum(len(s['words']) for s in segments)} words, language={out['language']}"
    )


if __name__ == "__main__":
    sys.exit(main())
