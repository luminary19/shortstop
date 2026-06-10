#!/usr/bin/env node
// Package skill/ as the release artifact: a tarball a user extracts to
// <project>/.claude/skills/shortstop/. Generated/bootstrapped content excluded.
import { execa } from 'execa';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(ROOT, 'skill', 'package.json'), 'utf8')).version;
const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
const out = join(dist, `shortstop-skill-${version}.tar.gz`);

await execa('tar', [
  '--exclude=node_modules', '--exclude=.venv', '--exclude=models',
  '--exclude=.shortstop-ready', '--exclude=package-lock.json',
  '-czf', out, '-C', join(ROOT, 'skill'), '.',
]);
const { stdout } = await execa('tar', ['-tzf', out]);
console.log(`packaged ${out} (${stdout.split('\n').length} entries)`);
