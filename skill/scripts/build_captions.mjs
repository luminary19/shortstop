#!/usr/bin/env node
// Stage 5 — kept words → karaoke ASS captions in OUTPUT time.
// Word → output time mapping happens here and only here (with render.mjs's crop
// remap, the two sanctioned source→output conversions, both via timecode.mjs).
// Usage: node build_captions.mjs <runDir>
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readArtifact, loadConfig } from './lib/artifacts.mjs';
import { snapToFrame } from './lib/timecode.mjs';

const EPS = 1e-3;

function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function sanitize(word) {
  return word.replace(/[{}\\]/g, '').trim();
}

// Map kept words to output time; tag each with its keep index (cut junctions).
export function mapWordsToOutput(transcript, edl, probe) {
  const { fps_num: num, fps_den: den } = probe;
  const words = transcript.segments.flatMap((s) => s.words);
  const out = [];
  let offset = 0;
  edl.keep.forEach((k, ki) => {
    for (const w of words) {
      if (w.start >= k.start - EPS && w.end <= k.end + EPS) {
        const start = snapToFrame(Math.max(0, w.start - k.start) + offset, num, den);
        const end = snapToFrame(Math.min(k.end - k.start, w.end - k.start) + offset, num, den);
        out.push({ word: sanitize(w.word), start, end: Math.max(end, start + 0.01), keep: ki });
      }
    }
    offset += k.end - k.start;
  });
  out.sort((a, b) => a.start - b.start);
  return { words: out.filter((w) => w.word), outputDuration: offset };
}

// Line grouping (§5.6): max words, max line seconds, sentence punctuation, cut junction.
export function groupLines(words, cfg) {
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) { lines.push(cur); cur = []; } };
  for (const w of words) {
    if (cur.length &&
        (cur.length >= cfg.max_words_per_line ||
         w.end - cur[0].start > cfg.max_line_s ||
         w.keep !== cur[cur.length - 1].keep)) {
      flush();
    }
    cur.push(w);
    if (/[.!?]$/.test(w.word)) flush();
  }
  flush();
  return lines;
}

// captions.size/margin_v/outline are tuned at a 1920-high output; scale them
// to the actual PlayRes height so 720x1280 shorts and 1920x1080 longform get
// the same visual proportion.
const CAPTION_REF_H = 1920;

export function buildAss(transcript, edl, probe, config) {
  const playW = config.aspect.mode === 'source' ? probe.display_width : config.aspect.out_width;
  const playH = config.aspect.mode === 'source' ? probe.display_height : config.aspect.out_height;
  const capScale = playH / CAPTION_REF_H;
  const cfg = {
    ...config.captions,
    size: Math.max(8, Math.round(config.captions.size * capScale)),
    margin_v: Math.round(config.captions.margin_v * capScale),
    outline: Math.max(1, Math.round(config.captions.outline * capScale)),
  };
  const { words, outputDuration } = mapWordsToOutput(transcript, edl, probe);
  const lines = groupLines(words, cfg);

  // Karaoke semantics: text renders in SecondaryColour and flips to
  // PrimaryColour as each word's \k duration elapses → Primary = highlight.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playW}
PlayResY: ${playH}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${cfg.font},${cfg.size},${cfg.highlight_color},${cfg.primary_color},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${cfg.outline},0,2,60,60,${cfg.margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = lines.map((line) => {
    const start = line[0].start;
    const end = line[line.length - 1].end;
    const parts = line.map((w, i) => {
      // each word's karaoke duration runs to the next word's start (fills gaps)
      const until = i < line.length - 1 ? line[i + 1].start : w.end;
      const kcs = Math.max(1, Math.round((until - w.start) * 100));
      return `{\\k${kcs}}${w.word}`;
    });
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${parts.join(' ')}`;
  });

  return { ass: header + events.join('\n') + '\n', outputDuration, lineCount: lines.length };
}

export function captionsStage(runDir, { config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const transcript = readArtifact('transcript', join(runDir, 'transcript.json'));
  const edl = readArtifact('edl', join(runDir, 'edl.json'));
  const { ass, outputDuration, lineCount } = buildAss(transcript, edl, probe, config);
  const outPath = join(runDir, 'captions.ass');
  writeFileSync(outPath, ass);
  return { outPath, outputDuration, lineCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) {
    console.error('usage: build_captions.mjs <runDir>');
    process.exit(1);
  }
  try {
    const { outPath, lineCount, outputDuration } = captionsStage(runDir);
    console.log(`captions: ${lineCount} lines over ${outputDuration.toFixed(2)}s -> ${outPath}`);
  } catch (err) {
    console.error(`captions failed: ${err.message}`);
    process.exit(1);
  }
}
