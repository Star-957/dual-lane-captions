import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { expectedBrowserBundle } from '../demo/build-bundle.mjs';

const app = await readFile(new URL('../demo/app.js', import.meta.url), 'utf8');
const bundle = await readFile(new URL('../demo/core.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../demo/index.html', import.meta.url), 'utf8');

function loadDemo(document) {
  const context = vm.createContext(document ? { document } : {});
  vm.runInContext(bundle, context);
  vm.runInContext(app, context);
  return context.SubtitleDemo;
}

function element() {
  return {
    textContent: '', hidden: true, dataset: {},
    set innerHTML(_) { throw new Error('HTML insertion is forbidden'); },
  };
}

test('the included browser bundle matches the current canonical core', async () => {
  assert.equal(bundle, await expectedBrowserBundle());
});

test('the view displays markup as text and independently clears both lanes', () => {
  const elements = Object.fromEntries(['speech', 'speechLabel', 'listening', 'listeningLabel']
    .map((name) => [name, element()]));
  const view = loadDemo().createView(elements);
  const payload = '<img src=x onerror=alert(1)>';
  view.render({ speech: { text: payload, label: 'SPEECH', final: true },
    listening: { text: 'Synthetic question.', label: 'INPUT', final: false } });
  assert.equal(elements.speech.textContent, payload);
  assert.equal(elements.speech.hidden, false);
  view.render({ speech: null, listening: { text: 'Retained input.', label: 'INPUT', final: true } });
  assert.equal(elements.speech.textContent, '');
  assert.equal(elements.speechLabel.hidden, true);
  assert.equal(elements.listening.textContent, 'Retained input.');
  view.render({ speech: null, listening: null });
  assert.equal(elements.listening.textContent, '');
  assert.equal(elements.listening.hidden, true);
});

test('demo actions exercise real revision rejection, lane isolation and expiry', () => {
  const frames = [];
  const demo = loadDemo().createDemo((frame, note, now) => frames.push({ frame, note, now }));
  assert.equal(frames[0].frame.speech, null);
  assert.match(demo.update().note, /Show a sample/);
  const shown = demo.show();
  assert.ok(shown.frame.speech);
  assert.ok(shown.frame.listening);
  const originalSpeech = shown.frame.speech.text;
  const updated = demo.update();
  assert.equal(updated.frame.speech.text, originalSpeech);
  assert.notEqual(updated.frame.listening.text, shown.frame.listening.text);
  const stale = demo.stale();
  assert.match(stale.note, /STALE_REVISION/);
  assert.equal(stale.frame.listening.text, updated.frame.listening.text);
  const expired = demo.expire();
  assert.equal(expired.frame.speech, null);
  assert.equal(expired.frame.listening, null);
  assert.equal(demo.reset().now, 0);
  assert.ok(demo.show().frame.speech);
});

test('all HTML buttons are wired to a visible status and clock', () => {
  const nodes = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const node = element();
    node.events = new Map();
    node.addEventListener = (name, callback) => node.events.set(name, callback);
    nodes.set(match[1], node);
  }
  loadDemo({ getElementById: (id) => nodes.get(id) });
  for (const action of ['show', 'update', 'stale', 'expire', 'reset']) {
    assert.equal(typeof nodes.get(action).events.get('click'), 'function');
    nodes.get(action).events.get('click')();
  }
  assert.equal(nodes.get('clock').textContent, 'Clock: 0 ms');
  assert.equal(nodes.get('speech-text').hidden, true);
  assert.equal(nodes.get('listening-text').hidden, true);
  assert.match(nodes.get('status').textContent, /Reset/);
});

test('the standalone demo declares no network capability or remote resources', () => {
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /(?:src|href)=["'](?:https?:|\/\/)/i);
  assert.doesNotMatch(app + bundle, /\b(?:fetch|WebSocket|XMLHttpRequest|localStorage|sessionStorage)\b/);
});
