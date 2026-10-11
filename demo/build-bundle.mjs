import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sourceNames = ['timeline.mjs', 'plain-record-snapshot.mjs', 'subtitle-controller.mjs'];

export function buildBrowserBundle(sources) {
  if (sources.length !== sourceNames.length) throw new Error('three source modules are required');
  const cleaned = sources.map((source) => source
    .replace(/\r\n/g, '\n')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
    .trimEnd());
  return '// Generated from the three browser-compatible src modules. Run npm run build:demo.\n'
    + '(function attachCaptionCore(global) {\n"use strict";\n'
    + cleaned[0] + '\n' + cleaned[1] + '\n'
    + 'const snapshotRecord = snapshotPlainRecord;\n'
    + cleaned[2] + '\n'
    + 'global.CaptionCore = Object.freeze({ MAX_TIMELINE_MS, MAX_SUBTITLE_TEXT_LENGTH, '
    + 'MAX_SUBTITLE_HOLD_MS, PARTIAL_SUBTITLE_TTL_MS, createSubtitleState, '
    + 'applySubtitleCommand, createSpeechCaptionAuthority, deriveSubtitleFrame, nextSubtitleExpiry });\n'
    + '})(globalThis);\n';
}

export async function expectedBrowserBundle() {
  return buildBrowserBundle(await Promise.all(sourceNames.map((name) =>
    readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL('./core.js', import.meta.url), await expectedBrowserBundle(), 'utf8');
}
