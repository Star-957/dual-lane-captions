import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SUBTITLE_TEXT_LENGTH,
  applySubtitleCommand,
  createSpeechCaptionAuthority,
  createSubtitleState,
  deriveSubtitleFrame,
} from "../src/subtitle-controller.mjs";
import { MAX_TIMELINE_MS } from "../src/timeline.mjs";
import { CaptionBridge } from "../src/caption-bridge.mjs";

const speechAuthority = createSpeechCaptionAuthority();

function apply(state, command, receivedAtMs) {
  if (command?.type === "setSpeechCaption") {
    return speechAuthority.apply(state, command, { receivedAtMs });
  }
  return applySubtitleCommand(state, command, { receivedAtMs });
}

function applyBridge(bridge, command) {
  return bridge.apply({ ...command, generation: bridge.generation });
}

test("public setCaption remains a separate Listening listening lane", () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const result = apply(initial, {
    type: "setCaption",
    turnId: "listening-turn-1",
    revision: 1,
    text: "字幕の入力テスト。",
    final: false,
  }, 20);

  assert.equal(result.ok, true);
  assert.deepEqual(deriveSubtitleFrame(result.state, 20), {
    speech: null,
    listening: {
      final: false,
      label: "INPUT · LISTENING",
      text: "字幕の入力テスト。",
    },
  });
  assert.equal(deriveSubtitleFrame(initial, 20).listening, null, "input state stays immutable");
});

test("only the receiver-owned speech authority can enter the main Speech lane", () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const accepted = apply(initial, {
    type: "setSpeechCaption",
    turnId: "speech-turn-1",
    revision: 1,
    text: "字幕の出力を確認します。",
    final: false,
  }, 10);

  assert.equal(accepted.ok, true);
  assert.deepEqual(deriveSubtitleFrame(accepted.state, 10).speech, {
    final: false,
    label: "SPEECH · SPEAKING",
    text: "字幕の出力を確認します。",
  });

  const forged = applySubtitleCommand(initial, {
    type: "setSpeechCaption",
    turnId: "d2",
    revision: 1,
    text: "raw",
    final: false,
  }, { receivedAtMs: 10 });
  assert.equal(forged.ok, false);

  for (const bad of [
    { type: "setSpeechCaption", turnId: "d2", revision: 1, text: "[hand:{\"action\":\"send\"}]", final: false },
    { type: "setSpeechCaption", turnId: "d2", revision: 1, text: "[emo:angry] hello", final: false },
  ]) {
    const rejected = apply(initial, bad, 10);
    assert.equal(rejected.ok, false);
    assert.equal(deriveSubtitleFrame(rejected.state, 10).speech, null);
  }
});

test("newer partials win; stale revisions and retired turns cannot reappear", () => {
  let state = createSubtitleState({ nowMs: 0 });
  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-a",
    revision: 1,
    text: "最初",
    final: false,
  }, 10).state;
  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-a",
    revision: 2,
    text: "最初の文",
    final: false,
  }, 20).state;

  const stale = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-a",
    revision: 1,
    text: "古い",
    final: false,
  }, 30);
  assert.equal(stale.ok, false);
  assert.equal(deriveSubtitleFrame(stale.state, 30).speech.text, "最初の文");

  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-b",
    revision: 1,
    text: "新しいターン",
    final: false,
  }, 40).state;
  const retired = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-a",
    revision: 3,
    text: "戻ってきた古いターン",
    final: true,
  }, 50);
  assert.equal(retired.ok, false);
  assert.equal(deriveSubtitleFrame(retired.state, 50).speech.text, "新しいターン");
});

test("retired turns stay retired after more than sixty-four later turns", () => {
  let state = createSubtitleState({ nowMs: 0 });
  for (let index = 0; index < 70; index += 1) {
    const result = apply(state, {
      type: "setSpeechCaption",
      turnId: `speech-${index}`,
      revision: 1,
      text: `line ${index}`,
      final: false,
    }, index + 1);
    assert.equal(result.ok, true);
    state = result.state;
  }

  const replay = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-0",
    revision: 2,
    text: "very old replay",
    final: true,
  }, 71);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "RETIRED_TURN");
});

test("final and abandoned partial captions expire without hiding newer text", () => {
  let state = createSubtitleState({ nowMs: 0 });
  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "old",
    revision: 1,
    text: "old final",
    final: true,
    holdMs: 1_000,
  }, 100).state;
  assert.equal(deriveSubtitleFrame(state, 1_099).speech.text, "old final");

  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "new",
    revision: 1,
    text: "new partial",
    final: false,
  }, 500).state;
  assert.equal(deriveSubtitleFrame(state, 1_101).speech.text, "new partial");
  assert.equal(deriveSubtitleFrame(state, 15_501).speech, null, "abandoned partial fails safe");
});

test("zero hold cannot create a permanently stuck final caption", () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const result = apply(initial, {
    type: "setCaption",
    turnId: "listening-zero-hold",
    revision: 1,
    text: "must remain bounded",
    final: true,
    holdMs: 0,
  }, 1);
  assert.equal(result.ok, false);
  assert.equal(deriveSubtitleFrame(result.state, 1).listening, null);

  const partialHold = apply(initial, {
    type: "setCaption",
    turnId: "listening-partial-hold",
    revision: 1,
    text: "partial owns a fixed fail-safe TTL",
    final: false,
    holdMs: 500,
  }, 1);
  assert.equal(partialHold.ok, false);
});

test("clear is lane-specific and malformed payloads fail closed", () => {
  let state = createSubtitleState({ nowMs: 0 });
  state = apply(state, {
    type: "setCaption",
    turnId: "listening-1",
    revision: 1,
    text: "Listening line",
    final: false,
  }, 10).state;
  state = apply(state, {
    type: "setSpeechCaption",
    turnId: "speech-1",
    revision: 1,
    text: "Speech line",
    final: false,
  }, 20).state;

  state = apply(state, {
    type: "setCaption",
    clear: true,
    turnId: "listening-1",
    revision: 2,
  }, 30).state;
  assert.equal(deriveSubtitleFrame(state, 30).listening, null);
  assert.equal(deriveSubtitleFrame(state, 30).speech.text, "Speech line");

  for (const bad of [
    { type: "setCaption", turnId: "", revision: 1, text: "x", final: false },
    { type: "setCaption", turnId: "t", revision: 0, text: "x", final: false },
    { type: "setCaption", turnId: "t", revision: 1, text: "x".repeat(MAX_SUBTITLE_TEXT_LENGTH + 1), final: false },
    { type: "setCaption", turnId: "t", revision: 1, text: "x", final: false, html: "<b>x</b>" },
    { type: "requestTool", intent: "show this" },
  ]) {
    const rejected = apply(state, bad, 40);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.state, state);
  }
});

test("clear is scoped to the exact current turn and next revision", () => {
  let state = createSubtitleState({ nowMs: 0 });
  state = apply(state, {
    type: "setCaption",
    turnId: "listening-old",
    revision: 1,
    text: "old",
    final: false,
  }, 1).state;
  state = apply(state, {
    type: "setCaption",
    turnId: "listening-new",
    revision: 1,
    text: "new",
    final: false,
  }, 2).state;

  const delayed = apply(state, {
    type: "setCaption",
    clear: true,
    turnId: "listening-old",
    revision: 2,
  }, 3);
  assert.equal(delayed.ok, false);
  assert.equal(delayed.error.code, "STALE_CLEAR");
  assert.equal(deriveSubtitleFrame(delayed.state, 3).listening.text, "new");

  const current = apply(state, {
    type: "setCaption",
    clear: true,
    turnId: "listening-new",
    revision: 2,
  }, 4);
  assert.equal(current.ok, true);
  assert.equal(deriveSubtitleFrame(current.state, 4).listening, null);
});

test("derived frames keep the newest mobile-safe window for long speech", () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const longSpeech = Array.from({ length: 140 }, (_, index) => String(index % 10)).join("");
  const result = apply(initial, {
    type: "setSpeechCaption",
    turnId: "long-speech-turn",
    revision: 1,
    text: longSpeech,
    final: false,
  }, 10);
  const visible = deriveSubtitleFrame(result.state, 10).speech.text;
  assert.equal(Array.from(visible).length, 36);
  assert.equal(visible.startsWith("…"), true);
  assert.equal(visible.endsWith(longSpeech.slice(-24)), true);
});

test("mobile rolling windows never split emoji or combining grapheme clusters", () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const family = "👨‍👩‍👧‍👦";
  const speech = `${family}${"x".repeat(34)}`;
  const result = apply(initial, {
    type: "setSpeechCaption",
    turnId: "grapheme-safe-speech",
    revision: 1,
    text: speech,
    final: false,
  }, 10);
  assert.equal(result.ok, true);
  assert.equal(deriveSubtitleFrame(result.state, 10).speech.text, speech);

  const combining = `${"y".repeat(35)}e\u0301`;
  const revised = apply(result.state, {
    type: "setSpeechCaption",
    turnId: "grapheme-safe-speech",
    revision: 2,
    text: combining,
    final: false,
  }, 11);
  assert.equal(revised.ok, true);
  assert.equal(deriveSubtitleFrame(revised.state, 11).speech.text.endsWith("e\u0301"), true);
});

test("receiver time must be monotonic and caption states are deeply immutable", () => {
  const initial = createSubtitleState({ nowMs: 100 });
  const stale = apply(initial, {
    type: "setCaption",
    turnId: "listening",
    revision: 1,
    text: "late packet",
    final: false,
  }, 99);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "STALE_RECEIVER_TIME");
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.listening), true);
  assert.throws(() => { initial.nowMs = 0; }, TypeError);
  assert.throws(() => deriveSubtitleFrame(initial, 99), /cannot move backwards/u);
});

test("CaptionBridge matches the current async renderer apply seam", async () => {
  let nowMs = 100;
  const epochMs = 1_000_000;
  const frames = [];
  const bridge = new CaptionBridge({
    now: () => nowMs,
    epochNow: () => epochMs,
    render: (frame) => frames.push(frame),
  });

  assert.equal(bridge.capabilities.has("setCaption"), true);
  assert.equal(bridge.capabilities.has("setSpeechCaption"), false);
  assert.deepEqual(await applyBridge(bridge, {
    type: "setCaption",
    turnId: "listening-bridge",
    revision: 1,
    text: "輸入字幕測試。",
    final: true,
  }), { ok: true, note: "listening caption accepted" });

  nowMs = 110;
  assert.deepEqual(await bridge.applySpeakingFlag({
    until: epochMs + 1_000,
    text: "輸出字幕測試。",
    recent: [{ text: "輸出字幕測試。", start: epochMs, until: epochMs + 1_000 }],
  }), { ok: true, note: "speech speaking flag accepted" });

  assert.equal(frames.at(-1).listening.text, "輸入字幕測試。");
  assert.equal(frames.at(-1).speech.text, "輸出字幕測試。");
  assert.equal((await applyBridge(bridge, { type: "requestTool" })).ok, false);
});

test("advertised capabilities are snapshots and cannot disable real handlers", async () => {
  const bridge = new CaptionBridge({ now: () => 10 });
  const advertised = bridge.capabilities;
  advertised.clear();

  assert.equal(bridge.capabilities.has("setCaption"), true);
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "listening-capability",
    revision: 1,
    text: "still handled",
    final: true,
  })).ok, true);
});

test("generic callers cannot claim the private Speech speech namespace", async () => {
  let epochMs = 4_000_000;
  const bridge = new CaptionBridge({ now: () => 10, epochNow: () => epochMs });
  assert.deepEqual([...bridge.capabilities], ["setCaption"]);
  assert.equal((await applyBridge(bridge, {
    type: "setSpeechCaption",
    turnId: "speaking-flag-1",
    revision: 1,
    text: "forged raw text",
    final: true,
    provenance: "post-speech-sanitizer",
  })).ok, false);

  const accepted = await bridge.applySpeakingFlag({
    until: epochMs + 1_000,
    text: "real speaking flag",
    recent: [{ text: "real speaking flag", start: epochMs, until: epochMs + 1_000 }],
  });
  assert.equal(accepted.ok, true);
  assert.equal(bridge.frame().speech.text, "real speaking flag");
});

test("CaptionBridge can consume the caller-provided speaking state without trusting its clock", async () => {
  let monotonicMs = 200;
  let epochMs = 2_000_000;
  const frames = [];
  const bridge = new CaptionBridge({
    now: () => monotonicMs,
    epochNow: () => epochMs,
    render: (frame) => frames.push(frame),
  });

  assert.deepEqual(await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "Generic speech event.",
    recent: [],
  }), { ok: true, note: "speech speaking flag accepted" });
  assert.equal(frames.at(-1).speech.text, "Generic speech event.");

  assert.deepEqual(await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "Generic speech event.",
    recent: [],
  }), { ok: true, note: "speaking flag unchanged" });
  assert.equal(frames.length, 1, "an unchanged 300ms poll does not repaint");

  monotonicMs = 250;
  epochMs += 3_100;
  assert.deepEqual(await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{
      text: "Generic speech event.",
      start: epochMs - 3_100,
      until: epochMs,
    }],
  }), { ok: true, note: "speech caption cleared" });
  assert.equal(frames.at(-1).speech, null);

  const malformed = await bridge.applySpeakingFlag({ until: "forever", text: "bad" });
  assert.equal(malformed.ok, false);
  assert.match(malformed.note, /invalid speaking flag/u);
});

test("back-to-back speaking flags serialize without sharing a turn revision", async () => {
  let monotonicMs = 500;
  const epochMs = 3_000_000;
  const bridge = new CaptionBridge({
    now: () => monotonicMs++,
    epochNow: () => epochMs,
  });

  const first = bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "first line",
    recent: [{ text: "first line", start: epochMs, until: epochMs + 3_000 }],
  });
  const second = bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "second line",
    recent: [
      { text: "first line", start: epochMs, until: epochMs + 3_000 },
      { text: "second line", start: epochMs, until: epochMs + 3_000 },
    ],
  });
  const results = await Promise.all([first, second]);

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(bridge.frame().speech.text, "second line");
});

test("an expired old speaking flag cannot clear a newer active line", async () => {
  let monotonicMs = 600;
  const epochMs = 5_000_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "new active line",
    recent: [{ text: "new active line", start: epochMs, until: epochMs + 3_000 }],
  })).ok, true);

  const stale = await bridge.applySpeakingFlag({
    until: epochMs - 1,
    text: "old line",
    recent: [{ text: "old line", start: epochMs - 2_000, until: epochMs - 1 }],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "new active line");
});

test("a delayed but still-active old speaking flag cannot overwrite a newer line", async () => {
  let monotonicMs = 650;
  let epochMs = 5_500_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 5_000,
    text: "first active line",
    recent: [{ text: "first active line", start: epochMs, until: epochMs + 5_000 }],
  })).ok, true);

  epochMs += 1;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 6_000,
    text: "newer active line",
    recent: [
      { text: "first active line", start: epochMs - 1, until: epochMs + 4_999 },
      { text: "newer active line", start: epochMs, until: epochMs + 6_000 },
    ],
  })).ok, true);

  const stale = await bridge.applySpeakingFlag({
    until: epochMs + 4_999,
    text: "first active line",
    recent: [{ text: "first active line", start: epochMs - 1, until: epochMs + 4_999 }],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "newer active line");
});

test("an old barge-in record cannot clear a newer repeated sentence", async () => {
  let monotonicMs = 700;
  let epochMs = 6_000_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 5_000,
    text: "same words",
    recent: [{ text: "same words", start: epochMs, until: epochMs + 5_000 }],
  })).ok, true);

  const firstStart = epochMs;
  epochMs += 100;
  const oldClear = {
    until: epochMs,
    text: "",
    recent: [{ text: "same words", start: firstStart, until: epochMs }],
  };
  assert.equal((await bridge.applySpeakingFlag(oldClear)).ok, true);

  epochMs += 100;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 5_000,
    text: "same words",
    recent: [
      { text: "same words", start: firstStart, until: epochMs - 100 },
      { text: "same words", start: epochMs, until: epochMs + 5_000 },
    ],
  })).ok, true);

  const replayedOldClear = await bridge.applySpeakingFlag(oldClear);
  assert.equal(replayedOldClear.ok, false);
  assert.match(replayedOldClear.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "same words");
});

test("a newer same-text event is not hidden by an unchanged top-level flag signature", async () => {
  let monotonicMs = 750;
  let epochMs = 7_000_000;
  const firstStart = epochMs;
  const sharedUntil = epochMs + 5_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: sharedUntil,
    text: "same words",
    recent: [{ text: "same words", start: firstStart, until: sharedUntil }],
  })).ok, true);

  epochMs += 1_000;
  const newer = await bridge.applySpeakingFlag({
    until: sharedUntil,
    text: "same words",
    recent: [
      { text: "same words", start: firstStart, until: sharedUntil },
      { text: "same words", start: epochMs, until: epochMs + 1_000 },
    ],
  });
  assert.equal(newer.ok, true);
  assert.notEqual(newer.note, "speaking flag unchanged");

  const oldClear = await bridge.applySpeakingFlag({
    until: firstStart + 500,
    text: "",
    recent: [{ text: "same words", start: firstStart, until: firstStart + 500 }],
  });
  assert.equal(oldClear.ok, false);
  assert.match(oldClear.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "same words");
});

test("a line expires by its matching recent event instead of another line's top-level until", async () => {
  let monotonicMs = 800;
  let epochMs = 8_000_000;
  const flag = {
    until: epochMs + 5_000,
    text: "short current line",
    recent: [
      { text: "older long line", start: epochMs - 500, until: epochMs + 5_000 },
      { text: "short current line", start: epochMs, until: epochMs + 1_000 },
    ],
  };
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag(flag)).ok, true);

  epochMs += 1_500;
  const ended = await bridge.applySpeakingFlag(flag);
  assert.deepEqual(ended, { ok: true, note: "speech caption cleared" });
  assert.equal(bridge.frame().speech, null);
});

test("a cleared speech event cannot be resurrected by its old active snapshot", async () => {
  let monotonicMs = 850;
  let epochMs = 8_500_000;
  const start = epochMs;
  const active = {
    until: epochMs + 5_000,
    text: "do not resurrect",
    recent: [{ text: "do not resurrect", start, until: epochMs + 5_000 }],
  };
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag(active)).ok, true);

  epochMs += 100;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "do not resurrect", start, until: epochMs }],
  })).ok, true);
  const replay = await bridge.applySpeakingFlag(active);
  assert.equal(replay.ok, false);
  assert.match(replay.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech, null);
});

test("the same speech event cannot regress its own until or expiry timer", async () => {
  let monotonicMs = 900;
  const epochMs = 9_000_000;
  const scheduled = [];
  const bridge = new CaptionBridge({
    now: () => monotonicMs,
    epochNow: () => epochMs,
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 5_000,
    text: "stable lifetime",
    recent: [{ text: "stable lifetime", start: epochMs, until: epochMs + 5_000 }],
  })).ok, true);
  assert.equal(scheduled.at(-1).delayMs, 6_100);
  const scheduleCount = scheduled.length;

  const regressed = await bridge.applySpeakingFlag({
    until: epochMs + 5_000,
    text: "stable lifetime",
    recent: [{ text: "stable lifetime", start: epochMs, until: epochMs + 4_000 }],
  });
  assert.equal(regressed.ok, false);
  assert.match(regressed.note, /stale speaking flag/u);
  assert.equal(scheduled.length, scheduleCount);
  assert.equal(bridge.frame().speech.text, "stable lifetime");
});

test("a legacy synthetic event can adopt its later authoritative recent identity", async () => {
  let monotonicMs = 950;
  let epochMs = 9_500_100;
  const authoritativeStart = epochMs - 100;
  const until = epochMs + 5_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  const legacyActive = {
    until,
    text: "identity arrives later",
    recent: [],
  };
  assert.equal((await bridge.applySpeakingFlag(legacyActive)).ok, true);

  epochMs += 100;
  const promoted = await bridge.applySpeakingFlag({
    until,
    text: "identity arrives later",
    recent: [{ text: "identity arrives later", start: authoritativeStart, until }],
  });
  assert.equal(promoted.ok, true);
  assert.notEqual(promoted.note, "speaking flag unchanged");

  epochMs += 100;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "identity arrives later", start: authoritativeStart, until: epochMs }],
  })).ok, true);
  assert.equal(bridge.frame().speech, null);

  const replay = await bridge.applySpeakingFlag(legacyActive);
  assert.equal(replay.ok, false);
  assert.match(replay.note, /unsequenced|stale/u);
});

test("a future recent speech event cannot display or poison the event watermark", async () => {
  let monotonicMs = 1_000;
  let epochMs = 10_000_000;
  const start = epochMs + 1_000;
  const flag = {
    until: epochMs + 3_000,
    text: "not started yet",
    recent: [{ text: "not started yet", start, until: epochMs + 3_000 }],
  };
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  const future = await bridge.applySpeakingFlag(flag);
  assert.equal(future.ok, false);
  assert.match(future.note, /future speaking flag/u);
  assert.equal(bridge.frame().speech, null);

  epochMs = start;
  assert.equal((await bridge.applySpeakingFlag(flag)).ok, true);
  assert.equal(bridge.frame().speech.text, "not started yet");
});

test("a first-seen expired speech identity is retired instead of becoming extendable", async () => {
  let monotonicMs = 1_025;
  const start = 10_250_000;
  const epochMs = start + 2_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  const expired = await bridge.applySpeakingFlag({
    until: start + 1_000,
    text: "already ended",
    recent: [{ text: "already ended", start, until: start + 1_000 }],
  });
  assert.equal(expired.ok, true);
  assert.equal(bridge.frame().speech, null);

  const resurrected = await bridge.applySpeakingFlag({
    until: start + 3_000,
    text: "already ended",
    recent: [{ text: "already ended", start, until: start + 3_000 }],
  });
  assert.equal(resurrected.ok, false);
  assert.match(resurrected.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech, null);
});

test("a first-seen blank snapshot retires the expired recent history it proves", async () => {
  let monotonicMs = 1_030;
  let epochMs = 10_300_000;
  const start = epochMs - 1_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  const blank = await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "history only", start, until: epochMs }],
  });
  assert.equal(blank.ok, true);
  assert.equal(bridge.frame().speech, null);

  epochMs += 100;
  const replay = await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "history only",
    recent: [{ text: "history only", start, until: epochMs + 3_000 }],
  });
  assert.equal(replay.ok, false);
  assert.match(replay.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech, null);
});

test("a future-dated blank flag cannot clear speech before its event lifetime ends", async () => {
  let monotonicMs = 1_040;
  let epochMs = 10_400_000;
  const start = epochMs;
  const until = epochMs + 4_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until,
    text: "still speaking",
    recent: [{ text: "still speaking", start, until }],
  })).ok, true);

  epochMs += 100;
  const premature = await bridge.applySpeakingFlag({
    until,
    text: "",
    recent: [{ text: "still speaking", start, until }],
  });
  assert.equal(premature.ok, false);
  assert.match(premature.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "still speaking");

  epochMs = until;
  assert.equal((await bridge.applySpeakingFlag({
    until,
    text: "",
    recent: [{ text: "still speaking", start, until }],
  })).ok, true);
  assert.equal(bridge.frame().speech, null);
});

test("a stale pre-extension blank cannot clear the current extended speech lifetime", async () => {
  let monotonicMs = 1_045;
  let epochMs = 10_450_000;
  const start = epochMs - 100;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 4_000,
    text: "extended line",
    recent: [{ text: "extended line", start, until: epochMs + 4_000 }],
  })).ok, true);

  epochMs += 100;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 6_900,
    text: "extended line",
    recent: [{ text: "extended line", start, until: epochMs + 6_900 }],
  })).ok, true);

  epochMs += 4_900;
  const staleBlank = await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "extended line", start, until: epochMs - 1_000 }],
  });
  assert.equal(staleBlank.ok, false);
  assert.match(staleBlank.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "extended line");

  const currentClamp = await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "extended line", start, until: epochMs }],
  });
  assert.equal(currentClamp.ok, true);
  assert.equal(bridge.frame().speech, null);
});

test("a first duplicate occurrence cannot clear the accepted rightmost speech occurrence", async () => {
  let monotonicMs = 1_047;
  let epochMs = 10_470_000;
  const start = epochMs;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "same instant",
    recent: [
      { text: "same instant", start, until: epochMs + 1_000 },
      { text: "same instant", start, until: epochMs + 3_000 },
    ],
  })).ok, true);

  epochMs += 1_000;
  const firstOnly = await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [{ text: "same instant", start, until: epochMs }],
  });
  assert.equal(firstOnly.ok, false);
  assert.match(firstOnly.note, /stale speaking flag/u);
  assert.equal(bridge.frame().speech.text, "same instant");

  const bothClamped = await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [
      { text: "same instant", start, until: epochMs },
      { text: "same instant", start, until: epochMs },
    ],
  });
  assert.equal(bothClamped.ok, true);
  assert.equal(bridge.frame().speech, null);
});

test("legacy speaking-flag compatibility remains live beyond its bounded replay window", async () => {
  let monotonicMs = 1_050;
  let epochMs = 10_500_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });

  for (let index = 0; index < 40; index += 1) {
    const until = epochMs + 10;
    const active = await bridge.applySpeakingFlag({
      until,
      text: `legacy line ${index}`,
      recent: [],
    });
    assert.equal(active.ok, true, `legacy line ${index} should remain accepted`);
    epochMs = until;
    assert.equal((await bridge.applySpeakingFlag({
      until,
      text: "",
      recent: [],
    })).ok, true);
    epochMs += 1;
  }
});

test("a new short legacy line can follow a barge-cleared longer legacy line", async () => {
  let monotonicMs = 1_060;
  let epochMs = 10_600_000;
  const bridge = new CaptionBridge({ now: () => monotonicMs++, epochNow: () => epochMs });
  const longUntil = epochMs + 4_000;
  assert.equal((await bridge.applySpeakingFlag({
    until: longUntil,
    text: "long interrupted line",
    recent: [],
  })).ok, true);

  epochMs += 100;
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs,
    text: "",
    recent: [],
  })).ok, true);

  epochMs += 100;
  const shorter = await bridge.applySpeakingFlag({
    until: epochMs + 800,
    text: "new short line",
    recent: [],
  });
  assert.equal(shorter.ok, true);
  assert.equal(bridge.frame().speech.text, "new short line");
});

test("equal-start matching speech entries select the producer's rightmost event", async () => {
  const epochMs = 10_500_000;
  const scheduled = [];
  const bridge = new CaptionBridge({
    now: () => 0,
    epochNow: () => epochMs,
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 3_000,
    text: "same millisecond",
    recent: [
      { text: "same millisecond", start: epochMs, until: epochMs + 1_000 },
      { text: "same millisecond", start: epochMs, until: epochMs + 3_000 },
    ],
  })).ok, true);
  assert.equal(scheduled.at(-1).delayMs, 4_100);
});

test("hostile accessors fail closed instead of escaping the caption boundary", async () => {
  const initial = createSubtitleState({ nowMs: 0 });
  const command = {};
  Object.defineProperty(command, "type", {
    enumerable: true,
    get() { throw new Error("getter must not run"); },
  });
  const result = applySubtitleCommand(initial, command, { receivedAtMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_SUBTITLE");

  const bridge = new CaptionBridge({ now: () => 1, epochNow: () => 1 });
  const hostileFlag = new Proxy({}, {
    ownKeys() { throw new Error("ownKeys must not escape"); },
  });
  const flagResult = await bridge.applySpeakingFlag(hostileFlag);
  assert.deepEqual(flagResult, { ok: false, note: "invalid speaking flag" });

  const nestedFlag = {
    until: 2,
    text: "nested hostile value",
    recent: new Proxy([], {
      get() { throw new Error("nested getter must not escape"); },
    }),
  };
  const nestedResult = await bridge.applySpeakingFlag(nestedFlag);
  assert.deepEqual(nestedResult, { ok: false, note: "invalid speaking flag" });
});

test("bridge receipts never re-read an accepted command after its safe snapshot", async () => {
  const payload = {
    generation: 1,
    type: "setCaption",
    turnId: "proxy-snapshot",
    revision: 1,
    text: "safe snapshot",
    final: true,
  };
  const command = new Proxy({}, {
    ownKeys: () => Reflect.ownKeys(payload),
    getOwnPropertyDescriptor: (_target, key) => ({
      configurable: true,
      enumerable: true,
      value: payload[key],
      writable: true,
    }),
    get: (_target, key) => {
      if (key === "clear") throw new Error("original command was re-read");
      return payload[key];
    },
  });
  const bridge = new CaptionBridge({ now: () => 1 });

  await assert.doesNotReject(() => bridge.apply(command));
  assert.equal(bridge.frame(1).listening.text, "safe snapshot");
});

test("public apply snapshots mutable input before queueing", async () => {
  const bridge = new CaptionBridge({ now: () => 1 });
  const command = {
    generation: bridge.generation,
    type: "setCaption",
    turnId: "ingress-snapshot",
    revision: 1,
    text: "original text",
    final: true,
  };
  const pending = bridge.apply(command);
  command.turnId = "mutated-turn";
  command.text = "mutated text";

  assert.equal((await pending).ok, true);
  assert.equal(bridge.frame(1).listening.text, "original text");
});

test("a synchronous render failure does not consume the subtitle revision", async () => {
  let failRender = true;
  const bridge = new CaptionBridge({
    now: () => 1,
    render: () => {
      if (failRender) throw new Error("render failed");
    },
  });
  const command = {
    type: "setCaption",
    turnId: "render-retry",
    revision: 1,
    text: "retry me",
    final: true,
  };

  await assert.rejects(() => applyBridge(bridge, command), /render failed/u);
  assert.equal(bridge.frame(1).listening, null);
  failRender = false;
  assert.equal((await applyBridge(bridge, command)).ok, true);
  assert.equal(bridge.frame(1).listening.text, "retry me");
});

test("a renderer that paints and then throws is rolled back to the accepted state", async () => {
  let failAfterPaint = true;
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => 1,
    render: (frame) => {
      painted.push(frame.listening?.text ?? null);
      if (failAfterPaint && frame.listening?.text === "rejected paint") {
        throw new Error("painted then failed");
      }
    },
  });
  const command = {
    type: "setCaption",
    turnId: "paint-then-fail",
    revision: 1,
    text: "rejected paint",
    final: true,
  };

  await assert.rejects(() => applyBridge(bridge, command), /painted then failed/u);
  assert.equal(bridge.frame(1).listening, null);
  assert.equal(painted.at(-1), null, "rollback repaints the previously accepted empty frame");

  failAfterPaint = false;
  assert.equal((await applyBridge(bridge, command)).ok, true);
  assert.equal(bridge.frame(1).listening.text, "rejected paint");
});

test("an asynchronous render rejection is returned and remains retryable", async () => {
  let failRender = true;
  const bridge = new CaptionBridge({
    now: () => 1,
    render: async () => {
      if (failRender) throw new Error("async render failed");
    },
  });
  const command = {
    type: "setCaption",
    turnId: "async-render-retry",
    revision: 1,
    text: "retry async",
    final: true,
  };

  await assert.rejects(() => applyBridge(bridge, command), /async render failed/u);
  assert.equal(bridge.frame(1).listening, null);
  failRender = false;
  assert.equal((await applyBridge(bridge, command)).ok, true);
  assert.equal(bridge.frame(1).listening.text, "retry async");
});

test("async render latency cannot leave an already expired caption painted", { timeout: 1_000 }, async () => {
  let rawNow = 0;
  let releaseRender;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const painted = [];
  const scheduled = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: async (frame) => {
      painted.push(frame.listening?.text ?? null);
      if (frame.listening?.text === "brief async line") {
        signalStarted();
        await new Promise((resolve) => { releaseRender = resolve; });
      }
    },
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel: () => undefined,
  });
  const pending = applyBridge(bridge, {
    type: "setCaption",
    turnId: "latency-expiry",
    revision: 1,
    text: "brief async line",
    final: true,
    holdMs: 100,
  });
  await started;
  rawNow = 150;
  releaseRender();

  assert.equal((await pending).ok, true);
  assert.deepEqual(painted, ["brief async line", null]);
  assert.equal(scheduled.length, 0);
  assert.equal(bridge.frame().listening, null);
});

test("an explicit future frame read during render cannot be overwritten by the pending paint", { timeout: 1_000 }, async () => {
  let releaseRender;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => 0,
    render: async (frame) => {
      painted.push(frame.listening?.text ?? null);
      if (frame.listening?.text === "future-frame race") {
        signalStarted();
        await new Promise((resolve) => { releaseRender = resolve; });
      }
    },
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  const pending = applyBridge(bridge, {
    type: "setCaption",
    turnId: "future-frame-race",
    revision: 1,
    text: "future-frame race",
    final: true,
    holdMs: 100,
  });
  await started;
  assert.deepEqual(bridge.frame(1_000), { speech: null, listening: null });
  releaseRender();

  assert.equal((await pending).ok, true);
  assert.deepEqual(painted, ["future-frame race", null]);
  assert.equal(bridge.frame(1_000).listening, null);
});

test("async renders are awaited and serialized in command order", async () => {
  const pending = [];
  let painted = null;
  const bridge = new CaptionBridge({
    now: (() => { let value = 20; return () => value++; })(),
    render: (frame) => new Promise((resolve) => {
      pending.push(() => {
        painted = frame.listening?.text ?? null;
        resolve();
      });
    }),
  });
  const first = applyBridge(bridge, { type: "setCaption", turnId: "async-a", revision: 1, text: "A", final: true });
  const second = applyBridge(bridge, { type: "setCaption", turnId: "async-b", revision: 1, text: "B", final: true });
  await Promise.resolve();

  if (pending.length === 1) {
    pending.shift()();
    for (let index = 0; index < 10 && pending.length < 1; index += 1) await Promise.resolve();
    assert.equal(pending.length, 1, "second render starts only after the first resolves");
    pending.shift()();
  } else {
    const firstPaint = pending.shift();
    const secondPaint = pending.shift();
    secondPaint?.();
    firstPaint?.();
  }
  const receipts = await Promise.all([first, second]);
  assert.equal(receipts.every((receipt) => receipt.ok), true);
  assert.equal(painted, "B");
  assert.equal(bridge.frame().listening.text, "B");
});

test("an external command can queue while an async render is pending", { timeout: 1_000 }, async () => {
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const painted = [];
  const bridge = new CaptionBridge({
    now: (() => { let value = 30; return () => value++; })(),
    render: async (frame) => {
      if (frame.listening?.text === "A") {
        signalStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      painted.push(frame.listening?.text ?? null);
    },
  });

  const first = applyBridge(bridge, {
    type: "setCaption",
    turnId: "external-a",
    revision: 1,
    text: "A",
    final: true,
  });
  await started;
  const second = applyBridge(bridge, {
    type: "setCaption",
    turnId: "external-b",
    revision: 1,
    text: "B",
    final: true,
  });
  let secondSettled = false;
  second.finally(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false, "the external command waits instead of being rejected as re-entry");

  releaseFirst();
  const receipts = await Promise.all([first, second]);
  assert.equal(receipts.every((receipt) => receipt.ok), true);
  assert.deepEqual(painted, ["A", "B"]);
  assert.equal(bridge.frame().listening.text, "B");
});

test("render callbacks cannot re-enter apply and overwrite ordering", async () => {
  let innerReceipt;
  let bridge;
  bridge = new CaptionBridge({
    now: (() => { let value = 40; return () => value++; })(),
    render: async (frame) => {
      if (frame.listening?.text === "outer") {
        innerReceipt = await applyBridge(bridge, {
          type: "setCaption",
          turnId: "reentrant-inner",
          revision: 1,
          text: "inner",
          final: true,
        });
      }
    },
  });
  const outer = await applyBridge(bridge, {
    type: "setCaption",
    turnId: "reentrant-outer",
    revision: 1,
    text: "outer",
    final: true,
  });
  assert.equal(outer.ok, true);
  assert.equal(innerReceipt.ok, false);
  assert.match(innerReceipt.note, /reentrant/u);
  assert.equal(bridge.frame().listening.text, "outer");
});

test("async render re-entry is rejected instead of deadlocking the queue", { timeout: 1_000 }, async () => {
  let innerReceipt;
  let bridge;
  bridge = new CaptionBridge({
    now: (() => { let value = 50; return () => value++; })(),
    render: async (frame) => {
      if (frame.listening?.text === "outer async") {
        await Promise.resolve();
        innerReceipt = await applyBridge(bridge, {
          type: "setCaption",
          turnId: "async-reentrant-inner",
          revision: 1,
          text: "inner async",
          final: true,
        });
      }
    },
  });
  const outer = await applyBridge(bridge, {
    type: "setCaption",
    turnId: "async-reentrant-outer",
    revision: 1,
    text: "outer async",
    final: true,
  });

  assert.equal(outer.ok, true);
  assert.equal(innerReceipt.ok, false);
  assert.match(innerReceipt.note, /reentrant/u);
});

test("bridge rotates its bounded clock generation before the seven-day limit", async () => {
  let rawNow = 0;
  const bridge = new CaptionBridge({ now: () => rawNow });
  rawNow = MAX_TIMELINE_MS - 1_000;
  const crossing = await applyBridge(bridge, {
    type: "setCaption",
    turnId: "near-limit",
    revision: 1,
    text: "still alive",
    final: false,
  });
  assert.equal(crossing.ok, false);
  assert.match(crossing.note, /GENERATION_ROTATED/u);
  assert.equal(bridge.generation, 2);

  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "after-limit",
    revision: 1,
    text: "new generation",
    final: true,
  })).ok, true);
  assert.equal(bridge.frame().listening.text, "new generation");
});

test("a packet from an earlier generation cannot overwrite the rotated state", async () => {
  let rawNow = 0;
  const bridge = new CaptionBridge({ now: () => rawNow });
  const oldPacket = {
    generation: bridge.generation,
    type: "setCaption",
    turnId: "old-packet",
    revision: 1,
    text: "old packet",
    final: true,
  };

  rawNow = MAX_TIMELINE_MS + 1;
  const crossing = await bridge.apply(oldPacket);
  assert.equal(crossing.ok, false);
  assert.match(crossing.note, /GENERATION_ROTATED/u);
  assert.equal(bridge.generation, 2);
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "current-packet",
    revision: 1,
    text: "current packet",
    final: true,
  })).ok, true);

  const replay = await bridge.apply(oldPacket);
  assert.equal(replay.ok, false);
  assert.match(replay.note, /STALE_GENERATION/u);
  assert.equal(bridge.frame().listening.text, "current packet");
});

test("a retired packet cannot use time rotation to become fresh again", async () => {
  let rawNow = 0;
  const bridge = new CaptionBridge({ now: () => rawNow });
  const retiredPacket = {
    generation: bridge.generation,
    type: "setCaption",
    turnId: "retired-before-rotation",
    revision: 1,
    text: "old retired line",
    final: true,
  };
  assert.equal((await bridge.apply(retiredPacket)).ok, true);
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "current-before-rotation",
    revision: 1,
    text: "current line",
    final: true,
  })).ok, true);
  assert.equal((await bridge.apply(retiredPacket)).ok, false);

  rawNow = MAX_TIMELINE_MS - 1_000;
  const crossingReplay = await bridge.apply(retiredPacket);
  assert.equal(crossingReplay.ok, false);
  assert.match(crossingReplay.note, /GENERATION_ROTATED/u);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().listening, null);
});

test("time rotation clears an old generation instead of trapping a valid clear", async () => {
  let rawNow = 0;
  const bridge = new CaptionBridge({ now: () => rawNow });
  const boundary = MAX_TIMELINE_MS - 16_000;
  rawNow = boundary;
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "boundary-clear",
    revision: 1,
    text: "clear me at rotation",
    final: true,
    holdMs: 10_000,
  })).ok, true);

  rawNow = boundary + 1;
  const clearedByRotation = await applyBridge(bridge, {
    type: "setCaption",
    clear: true,
    turnId: "boundary-clear",
    revision: 2,
  });
  assert.equal(clearedByRotation.ok, false);
  assert.match(clearedByRotation.note, /GENERATION_ROTATED/u);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().listening, null);
});

test("an old speaking flag remains stale across time rotation", async () => {
  let rawNow = 0;
  let epochMs = 11_000_000;
  const firstStart = epochMs;
  const first = {
    until: epochMs + 5_000,
    text: "old speech",
    recent: [{ text: "old speech", start: firstStart, until: epochMs + 5_000 }],
  };
  const bridge = new CaptionBridge({ now: () => rawNow, epochNow: () => epochMs });
  assert.equal((await bridge.applySpeakingFlag(first)).ok, true);

  epochMs += 1;
  const second = {
    until: epochMs + 6_000,
    text: "new speech",
    recent: [
      { text: "old speech", start: firstStart, until: firstStart + 5_000 },
      { text: "new speech", start: epochMs, until: epochMs + 6_000 },
    ],
  };
  assert.equal((await bridge.applySpeakingFlag(second)).ok, true);

  rawNow = MAX_TIMELINE_MS - 1_000;
  const replay = await bridge.applySpeakingFlag(first);
  assert.equal(replay.ok, false);
  assert.match(replay.note, /stale speaking flag/u);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().speech, null);

  assert.equal((await bridge.applySpeakingFlag(second)).ok, true);
  assert.equal(bridge.frame().speech.text, "new speech");
});

test("bridge rotates instead of advertising a permanently exhausted turn lane", async () => {
  let rawNow = 0;
  const bridge = new CaptionBridge({
    now: () => rawNow++,
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  for (let index = 0; index <= 4_096; index += 1) {
    const receipt = await applyBridge(bridge, {
      type: "setCaption",
      turnId: `bounded-turn-${index}`,
      revision: 1,
      text: `line ${index}`,
      final: true,
    });
    assert.equal(receipt.ok, true, `turn ${index} remains serviceable`);
  }
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().listening.text, "line 4096");
});

test("a failed turn-limit rotation preserves the old state and generation for retry", async () => {
  let rawNow = 0;
  let failRotationRender = false;
  const bridge = new CaptionBridge({
    now: () => rawNow++,
    render: (frame) => {
      if (failRotationRender && frame.listening?.text === "rotation fail") {
        throw new Error("rotation render failed");
      }
    },
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  for (let index = 0; index < 4_096; index += 1) {
    const receipt = await applyBridge(bridge, {
      type: "setCaption",
      turnId: `atomic-turn-${index}`,
      revision: 1,
      text: `line ${index}`,
      final: true,
    });
    assert.equal(receipt.ok, true);
  }
  assert.equal(bridge.generation, 1);
  assert.equal(bridge.frame().listening.text, "line 4095");

  const rotationCommand = {
    type: "setCaption",
    turnId: "atomic-turn-4096",
    revision: 1,
    text: "rotation fail",
    final: true,
  };
  failRotationRender = true;
  await assert.rejects(() => applyBridge(bridge, rotationCommand), /rotation render failed/u);
  assert.equal(bridge.generation, 1);
  assert.equal(bridge.frame().listening.text, "line 4095");

  failRotationRender = false;
  assert.equal((await applyBridge(bridge, rotationCommand)).ok, true);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().listening.text, "rotation fail");
});

test("a scheduler setup failure rolls back the visual and leaves the command retryable", async () => {
  let failSchedule = true;
  const frames = [];
  const bridge = new CaptionBridge({
    now: () => 1,
    render: (frame) => frames.push(frame),
    schedule: () => {
      if (failSchedule) throw new Error("schedule setup failed");
      return { unref() {} };
    },
    cancel: () => undefined,
  });
  const command = {
    type: "setCaption",
    turnId: "schedule-retry",
    revision: 1,
    text: "retry after scheduler",
    final: true,
  };

  await assert.rejects(() => applyBridge(bridge, command), /schedule setup failed/u);
  assert.equal(bridge.frame(1).listening, null);
  assert.equal(frames.at(-1).listening, null, "the attempted visual is rolled back");

  failSchedule = false;
  assert.equal((await applyBridge(bridge, command)).ok, true);
  assert.equal(bridge.frame(1).listening.text, "retry after scheduler");
});

test("explicit frame reads and later commands share one monotonic timeline", async () => {
  const rendered = [];
  const bridge = new CaptionBridge({
    now: () => 0,
    render: (frame) => rendered.push(frame),
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  assert.deepEqual(bridge.frame(100), { speech: null, listening: null });
  assert.throws(() => bridge.frame(99), /cannot move backwards/u);

  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "after-frame-read",
    revision: 1,
    text: "still visible",
    final: true,
    holdMs: 50,
  })).ok, true);
  assert.equal(rendered.at(-1).listening.text, "still visible");
  assert.equal(bridge.frame(100).listening.text, "still visible");
});

test("owned expiry scheduling repaints a cleared frame without a new command", async () => {
  let rawNow = 0;
  let scheduled;
  const frames = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => frames.push(frame),
    schedule: (callback, delayMs) => {
      scheduled = { callback, delayMs, unref() {} };
      return scheduled;
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "scheduled-expiry",
    revision: 1,
    text: "brief line",
    final: true,
    holdMs: 100,
  })).ok, true);
  assert.equal(scheduled.delayMs, 100);

  rawNow = 100;
  await scheduled.callback();
  assert.equal(frames.at(-1).listening, null);
});

test("a transient expiry render failure schedules a bounded retry", async () => {
  let rawNow = 0;
  const scheduled = [];
  let scheduleCalls = 0;
  let failExpiryOnce = true;
  const frames = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: async (frame) => {
      if (rawNow >= 100 && failExpiryOnce) {
        failExpiryOnce = false;
        throw new Error("transient expiry render failure");
      }
      frames.push(frame);
    },
    schedule: (callback, delayMs) => {
      scheduleCalls += 1;
      const handle = { callback, delayMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "expiry-retry",
    revision: 1,
    text: "clear after retry",
    final: true,
    holdMs: 100,
  })).ok, true);
  assert.equal(scheduleCalls, 1);

  rawNow = 100;
  await scheduled[0].callback().catch(() => undefined);
  assert.equal(scheduleCalls, 2, "a rejected expiry repaint must really arm a new timer");
  assert.equal(scheduled[1].delayMs, 100);
  await scheduled[1].callback();
  assert.equal(frames.at(-1).listening, null);
});

test("an async expiry repaint catches up when the other lane expires while rendering", { timeout: 1_000 }, async () => {
  let rawNow = 0;
  const epochMs = 12_000_000;
  let releaseExpiry;
  let signalExpiryStarted;
  const expiryStarted = new Promise((resolve) => { signalExpiryStarted = resolve; });
  const painted = [];
  const scheduled = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    epochNow: () => epochMs,
    render: async (frame) => {
      painted.push({
        speech: frame.speech?.text ?? null,
        listening: frame.listening?.text ?? null,
      });
      if (rawNow === 100 && frame.listening === null && frame.speech?.text === "second lane") {
        signalExpiryStarted();
        await new Promise((resolve) => { releaseExpiry = resolve; });
      }
    },
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "first-expiry",
    revision: 1,
    text: "first lane",
    final: true,
    holdMs: 100,
  })).ok, true);
  assert.equal((await bridge.applySpeakingFlag({
    until: epochMs + 100,
    text: "second lane",
    recent: [{ text: "second lane", start: epochMs, until: epochMs + 100 }],
  })).ok, true);
  const expiryHandle = scheduled.at(-1);
  assert.equal(expiryHandle.delayMs, 100);
  const scheduleCount = scheduled.length;

  rawNow = 100;
  const expiry = expiryHandle.callback();
  await expiryStarted;
  rawNow = 2_000;
  releaseExpiry();
  await expiry;

  assert.deepEqual(painted.at(-1), { speech: null, listening: null });
  assert.equal(scheduled.length, scheduleCount, "no stale second-lane timer is re-armed");
  assert.deepEqual(bridge.frame(), { speech: null, listening: null });
});

test("epoch rollback fails closed without resurrecting or clearing speech", async () => {
  let rawNow = 0;
  let epochNow = 8_000_000;
  const bridge = new CaptionBridge({ now: () => rawNow++, epochNow: () => epochNow });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochNow + 1_000,
    text: "clock-safe line",
    recent: [{ text: "clock-safe line", start: epochNow, until: epochNow + 1_000 }],
  })).ok, true);

  epochNow -= 1;
  const rollback = await bridge.applySpeakingFlag({
    until: epochNow + 1_000,
    text: "rollback line",
    recent: [{ text: "rollback line", start: epochNow, until: epochNow + 1_000 }],
  });
  assert.equal(rollback.ok, false);
  assert.match(rollback.note, /moved backwards/u);
  assert.equal(bridge.frame().speech.text, "clock-safe line");
});

test("default bridge owns a fresh monotonic generation and rejected flags never become cached success", async () => {
  const bridge = new CaptionBridge();
  assert.deepEqual(bridge.frame(), { speech: null, listening: null });

  const invalid = {
    until: Date.now() + 1_000,
    text: "[emo:angry] must not leak",
    recent: [],
  };
  const first = await bridge.applySpeakingFlag(invalid);
  const second = await bridge.applySpeakingFlag(invalid);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.notEqual(second.note, "speaking flag unchanged");
});

test("a post-paint monotonic-clock failure rolls the visual back to accepted state", async () => {
  const readings = [0, 0, -1, 0, 0];
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => readings.shift() ?? 0,
    render: (frame) => painted.push(frame.listening?.text ?? null),
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });

  await assert.rejects(() => applyBridge(bridge, {
    type: "setCaption",
    turnId: "post-paint-clock-failure",
    revision: 1,
    text: "must roll back",
    final: true,
    holdMs: 100,
  }), /clock/u);
  assert.deepEqual(painted, ["must roll back", null]);
  assert.equal(bridge.frame(0).listening, null);
});

test("scheduler and cancellation hooks cannot advance the public frame during a commit", async () => {
  let bridge;
  let cancelMustProbe = false;
  let scheduleProbes = 0;
  let cancelProbes = 0;
  bridge = new CaptionBridge({
    now: () => 0,
    render: () => undefined,
    schedule: () => {
      scheduleProbes += 1;
      assert.throws(() => bridge.frame(1_000), /reentrant/u);
      return { unref() {} };
    },
    cancel: () => {
      if (!cancelMustProbe) return;
      cancelProbes += 1;
      assert.throws(() => bridge.frame(1_000), /reentrant/u);
    },
  });

  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "scheduler-reentry-a",
    revision: 1,
    text: "A",
    final: true,
    holdMs: 5_000,
  })).ok, true);
  cancelMustProbe = true;
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "scheduler-reentry-b",
    revision: 1,
    text: "B",
    final: true,
    holdMs: 100,
  })).ok, true);

  assert.equal(scheduleProbes, 2);
  assert.equal(cancelProbes, 1);
  assert.equal(bridge.frame(0).listening.text, "B");
});

test("speech expiration is re-read after an awaited clock-generation rotation", { timeout: 1_000 }, async () => {
  let rawNow = 0;
  let epochNow = 11_000_000;
  let releaseRotation;
  let signalRotation;
  let blocked = false;
  const rotationStarted = new Promise((resolve) => { signalRotation = resolve; });
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    epochNow: () => epochNow,
    render: async (frame) => {
      painted.push(frame.speech?.text ?? null);
      if (!blocked && frame.speech === null && frame.listening === null) {
        blocked = true;
        signalRotation();
        await new Promise((resolve) => { releaseRotation = resolve; });
      }
    },
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  rawNow = MAX_TIMELINE_MS;
  const pending = bridge.applySpeakingFlag({
    until: epochNow + 100,
    text: "expired during rotation",
    recent: [{ text: "expired during rotation", start: epochNow, until: epochNow + 100 }],
  });
  await rotationStarted;
  rawNow += 2_000;
  epochNow += 2_000;
  releaseRotation();

  assert.equal((await pending).ok, true);
  assert.deepEqual(painted, [null]);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.frame().speech, null);
});

test("a blocked renderer applies bounded backpressure instead of growing an unlimited queue", { timeout: 1_000 }, async () => {
  let releaseFirst;
  let signalFirst;
  let blocked = false;
  const firstStarted = new Promise((resolve) => { signalFirst = resolve; });
  const bridge = new CaptionBridge({
    now: () => 0,
    render: async (frame) => {
      if (!blocked && frame.listening?.text === "queue head") {
        blocked = true;
        signalFirst();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
    },
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });

  const first = applyBridge(bridge, {
    type: "setCaption",
    turnId: "queue-head",
    revision: 1,
    text: "queue head",
    final: true,
  });
  await firstStarted;
  let busyReceipts = 0;
  const flood = Array.from({ length: 160 }, (_, index) => applyBridge(bridge, {
    type: "setCaption",
    turnId: `queue-${index}`,
    revision: 1,
    text: `queued ${index}`,
    final: true,
  }).then((receipt) => {
    if (/CAPTION_BUSY/u.test(receipt.note)) busyReceipts += 1;
    return receipt;
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(busyReceipts > 0, "overflow commands should settle immediately with bounded backpressure");

  releaseFirst();
  const receipts = await Promise.all([first, ...flood]);
  assert.ok(receipts.filter((receipt) => receipt.ok).length <= 128);
  assert.equal(receipts.filter((receipt) => /CAPTION_BUSY/u.test(receipt.note)).length, busyReceipts);
});

test("a failed timer setup can never reuse its leaked callback token on retry", async () => {
  let rawNow = 0;
  let failUnref = true;
  const callbacks = [];
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => painted.push(frame.listening?.text ?? null),
    schedule: (callback) => {
      callbacks.push(callback);
      return {
        unref() {
          if (failUnref) throw new Error("unref failed after callback escaped");
        },
      };
    },
    cancel: () => undefined,
  });
  const command = {
    type: "setCaption",
    turnId: "timer-token-retry",
    revision: 1,
    text: "retry without ABA",
    final: true,
    holdMs: 100,
  };

  await assert.rejects(() => applyBridge(bridge, command), /unref failed/u);
  failUnref = false;
  assert.equal((await applyBridge(bridge, command)).ok, true);
  const paintsBeforeLeak = painted.length;
  const schedulesBeforeLeak = callbacks.length;
  rawNow = 50;
  await callbacks[0]();
  assert.equal(painted.length, paintsBeforeLeak);
  assert.equal(callbacks.length, schedulesBeforeLeak);
});

test("scheduler and cancel latency are reconciled before an accepted receipt returns", async () => {
  let rawNow = 0;
  let bridge;
  let scheduleShouldAdvance = true;
  const scheduledPaints = [];
  bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => scheduledPaints.push(frame.listening?.text ?? null),
    schedule: () => {
      if (scheduleShouldAdvance) rawNow = 150;
      return { unref() {} };
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "schedule-latency",
    revision: 1,
    text: "already expired in schedule",
    final: true,
    holdMs: 100,
  })).ok, true);
  assert.equal(scheduledPaints.at(-1), null);
  assert.equal(bridge.frame().listening, null);

  rawNow = 0;
  scheduleShouldAdvance = false;
  let cancelShouldAdvance = false;
  const cancelledPaints = [];
  bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => cancelledPaints.push(frame.listening?.text ?? null),
    schedule: () => ({ unref() {} }),
    cancel: () => {
      if (cancelShouldAdvance) rawNow = 1_000;
    },
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "cancel-latency-a",
    revision: 1,
    text: "A",
    final: true,
    holdMs: 5_000,
  })).ok, true);
  cancelShouldAdvance = true;
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "cancel-latency-b",
    revision: 1,
    text: "B",
    final: true,
    holdMs: 100,
  })).ok, true);
  assert.equal(cancelledPaints.at(-1), null);
  assert.equal(bridge.frame().listening, null);
});

test("one expiry handle can enqueue at most one in-flight repaint", { timeout: 1_000 }, async () => {
  let rawNow = 0;
  let handle;
  let releaseExpiry;
  let signalExpiry;
  let blocked = false;
  const expiryStarted = new Promise((resolve) => { signalExpiry = resolve; });
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: async (frame) => {
      if (!blocked && frame.listening === null) {
        blocked = true;
        signalExpiry();
        await new Promise((resolve) => { releaseExpiry = resolve; });
      }
    },
    schedule: (callback, delayMs) => {
      handle = { callback, delayMs, unref() {} };
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "expiry-dedupe",
    revision: 1,
    text: "short",
    final: true,
    holdMs: 100,
  })).ok, true);
  rawNow = 100;
  const firstExpiry = handle.callback();
  await expiryStarted;
  let duplicateSettled = 0;
  const duplicates = Array.from({ length: 512 }, () => handle.callback().then(() => {
    duplicateSettled += 1;
  }));
  await Promise.resolve();
  await Promise.resolve();
  const settledWhileBlocked = duplicateSettled;
  releaseExpiry();
  await Promise.all([firstExpiry, ...duplicates]);
  assert.equal(settledWhileBlocked, 512);
});

test("a scheduler that fires during setup is rejected instead of creating a timer loop", async () => {
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => 0,
    render: (frame) => painted.push(frame.listening?.text ?? null),
    schedule: (callback) => {
      callback();
      return { unref() {} };
    },
    cancel: () => undefined,
  });
  await assert.rejects(() => applyBridge(bridge, {
    type: "setCaption",
    turnId: "sync-scheduler",
    revision: 1,
    text: "must not loop",
    final: true,
    holdMs: 100,
  }), /asynchronous/u);
  assert.equal(painted.at(-1), null);
  assert.equal(bridge.frame(0).listening, null);
});

test("an asynchronous rollback catches up with a frame advanced while rollback is painting", { timeout: 1_000 }, async () => {
  let releaseRollback;
  let signalRollback;
  let sawRejectedPaint = false;
  let blockedRollback = false;
  const rollbackStarted = new Promise((resolve) => { signalRollback = resolve; });
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => 0,
    render: async (frame) => {
      const text = frame.listening?.text ?? null;
      painted.push(text);
      if (text === "B") {
        sawRejectedPaint = true;
        throw new Error("reject B after paint");
      }
      if (sawRejectedPaint && text === "A" && !blockedRollback) {
        blockedRollback = true;
        signalRollback();
        await new Promise((resolve) => { releaseRollback = resolve; });
      }
    },
    schedule: () => ({ unref() {} }),
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "rollback-current-a",
    revision: 1,
    text: "A",
    final: true,
    holdMs: 5_000,
  })).ok, true);
  const rejected = applyBridge(bridge, {
    type: "setCaption",
    turnId: "rollback-current-b",
    revision: 1,
    text: "B",
    final: true,
    holdMs: 5_000,
  });
  await rollbackStarted;
  assert.equal(bridge.frame(6_000).listening, null);
  releaseRollback();
  await assert.rejects(() => rejected, /reject B/u);
  assert.equal(painted.at(-1), null);
  assert.equal(bridge.frame(6_000).listening, null);
});

test("an expiry callback reconciles time advanced by scheduling the next lane", async () => {
  let rawNow = 0;
  const epochNow = 12_000_000;
  let advanceWhileRescheduling = false;
  const handles = [];
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    epochNow: () => epochNow,
    render: (frame) => painted.push({
      speech: frame.speech?.text ?? null,
      listening: frame.listening?.text ?? null,
    }),
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() {} };
      handles.push(handle);
      if (advanceWhileRescheduling) rawNow = 1_300;
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochNow + 100,
    text: "second lane",
    recent: [{ text: "second lane", start: epochNow, until: epochNow + 100 }],
  })).ok, true);
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "first-expiry-lane",
    revision: 1,
    text: "first lane",
    final: true,
    holdMs: 100,
  })).ok, true);
  const firstExpiry = handles.at(-1);
  assert.equal(firstExpiry.delayMs, 100);

  rawNow = 100;
  advanceWhileRescheduling = true;
  await firstExpiry.callback();
  assert.deepEqual(painted.at(-1), { speech: null, listening: null });
  assert.deepEqual(bridge.frame(), { speech: null, listening: null });
});

test("a failed retry arm invalidates every callback leaked by that failed arm", async () => {
  let rawNow = 0;
  let scheduleCalls = 0;
  let initialCallback;
  let leakedRetryCallback;
  let failExpiryRender = true;
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => {
      painted.push(frame.listening?.text ?? null);
      if (rawNow === 100 && failExpiryRender) {
        failExpiryRender = false;
        throw new Error("expiry paint failed once");
      }
    },
    schedule: (callback) => {
      scheduleCalls += 1;
      if (scheduleCalls === 1) initialCallback = callback;
      if (scheduleCalls === 2) leakedRetryCallback = callback;
      return {
        unref() {
          if (scheduleCalls === 2) throw new Error("retry unref failed");
        },
      };
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "retry-arm-token",
    revision: 1,
    text: "short retry",
    final: true,
    holdMs: 100,
  })).ok, true);

  rawNow = 100;
  await initialCallback().catch(() => undefined);
  assert.equal(typeof leakedRetryCallback, "function");
  const paintsBeforeLeak = painted.length;
  await leakedRetryCallback();
  assert.equal(painted.length, paintsBeforeLeak);
});

test("timer scheduling re-arms against the remaining deadline after synchronous latency", async () => {
  let rawNow = 0;
  let advanceOnce = true;
  const handles = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: () => undefined,
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, armedAt: rawNow, unref() {} };
      handles.push(handle);
      if (advanceOnce) {
        advanceOnce = false;
        rawNow = 500;
      }
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "deadline-rearm",
    revision: 1,
    text: "deadline",
    final: true,
    holdMs: 1_000,
  })).ok, true);
  assert.equal(handles.length, 2);
  assert.deepEqual(
    handles.map(({ delayMs, armedAt }) => ({ delayMs, armedAt })),
    [
      { delayMs: 1_000, armedAt: 0 },
      { delayMs: 500, armedAt: 500 },
    ],
  );
});

test("retry-arm hook failure heals the visual after advancing beyond every lane", async () => {
  let rawNow = 0;
  const epochNow = 13_000_000;
  let scheduleCalls = 0;
  let starExpiry;
  let failFirstExpiryPaint = true;
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    epochNow: () => epochNow,
    render: (frame) => {
      const snapshot = {
        speech: frame.speech?.text ?? null,
        listening: frame.listening?.text ?? null,
      };
      painted.push(snapshot);
      if (
        rawNow === 100
        && snapshot.speech === "second lane"
        && snapshot.listening === null
        && failFirstExpiryPaint
      ) {
        failFirstExpiryPaint = false;
        throw new Error("first expiry paint failed");
      }
    },
    schedule: (callback, delayMs) => {
      scheduleCalls += 1;
      const handle = {
        callback,
        delayMs,
        unref() {
          if (scheduleCalls === 3) {
            rawNow = 1_300;
            throw new Error("retry arm failed after latency");
          }
        },
      };
      if (scheduleCalls === 2) starExpiry = handle;
      return handle;
    },
    cancel: () => undefined,
  });
  assert.equal((await bridge.applySpeakingFlag({
    until: epochNow + 100,
    text: "second lane",
    recent: [{ text: "second lane", start: epochNow, until: epochNow + 100 }],
  })).ok, true);
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "retry-heal-first",
    revision: 1,
    text: "first lane",
    final: true,
    holdMs: 100,
  })).ok, true);

  rawNow = 100;
  await starExpiry.callback();
  assert.deepEqual(painted.at(-1), { speech: null, listening: null });
  assert.deepEqual(bridge.frame(), { speech: null, listening: null });
});

test("failed-command timer restoration also converges after restoration-hook latency", async () => {
  let rawNow = 0;
  let scheduleCalls = 0;
  const painted = [];
  const bridge = new CaptionBridge({
    now: () => rawNow,
    render: (frame) => painted.push(frame.listening?.text ?? null),
    schedule: () => {
      scheduleCalls += 1;
      return {
        unref() {
          if (scheduleCalls === 2) {
            rawNow = 1_000;
            throw new Error("candidate timer setup failed");
          }
          if (scheduleCalls === 3) rawNow = 6_000;
        },
      };
    },
    cancel: () => undefined,
  });
  assert.equal((await applyBridge(bridge, {
    type: "setCaption",
    turnId: "restore-old-a",
    revision: 1,
    text: "A",
    final: true,
    holdMs: 5_000,
  })).ok, true);

  await assert.rejects(() => applyBridge(bridge, {
    type: "setCaption",
    turnId: "reject-new-b",
    revision: 1,
    text: "B",
    final: true,
    holdMs: 100,
  }), /candidate timer setup failed/u);
  assert.equal(painted.at(-1), null);
  assert.equal(bridge.frame().listening, null);
});
