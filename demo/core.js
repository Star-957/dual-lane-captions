// Generated from the three browser-compatible src modules. Run npm run build:demo.
(function attachCaptionCore(global) {
"use strict";
// Monotonic milliseconds within one caption generation. Rotate before this limit.
const MAX_TIMELINE_MS = 7 * 24 * 60 * 60 * 1_000;
function snapshotPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
const snapshotRecord = snapshotPlainRecord;

const MAX_SUBTITLE_TEXT_LENGTH = 4_096;
const MAX_SUBTITLE_HOLD_MS = 10_000;
const PARTIAL_SUBTITLE_TTL_MS = 15_000;

const MAX_TURN_ID_LENGTH = 128;
const MAX_TURNS_PER_LANE = 4_096;
const VISIBLE_SPEECH_GRAPHEMES = 36;
const VISIBLE_LISTENING_GRAPHEMES = 30;
const CANONICAL_STATES = new WeakSet();
const FORBIDDEN_SPEECH_MARKER = /\[(?:hand|emo)\s*:/iu;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function success(state, lane, operation = "updated") {
  return { ok: true, state, lane, operation };
}

function failure(state, code, message) {
  return { ok: false, state, error: { code, message } };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalState(value) {
  deepFreeze(value);
  CANONICAL_STATES.add(value);
  return value;
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMELINE_MS;
}

function exactFields(command, allowed) {
  const allowlist = new Set(allowed);
  return Object.keys(command).every((field) => allowlist.has(field));
}

function normalizeText(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_SUBTITLE_TEXT_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function validatePayload(command, lane) {
  const speech = lane === "speech";
  const contentFields = ["type", "turnId", "revision", "text", "final", "holdMs"];
  if (!exactFields(command, contentFields)) {
    return { ok: false, code: "INVALID_SUBTITLE", message: "subtitle contains unknown fields" };
  }
  if (
    typeof command.turnId !== "string"
    || command.turnId.length < 1
    || command.turnId.length > MAX_TURN_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(command.turnId)
    || !Number.isSafeInteger(command.revision)
    || command.revision < 1
    || typeof command.final !== "boolean"
  ) {
    return { ok: false, code: "INVALID_SUBTITLE", message: "subtitle identity or revision is invalid" };
  }
  const text = normalizeText(command.text);
  if (!text) {
    return { ok: false, code: "INVALID_SUBTITLE", message: "subtitle text is invalid" };
  }
  if (speech && FORBIDDEN_SPEECH_MARKER.test(text)) {
    return { ok: false, code: "INTERNAL_MARKER_REJECTED", message: "internal emotion or tool markers are never captions" };
  }
  if (!command.final && Object.hasOwn(command, "holdMs")) {
    return { ok: false, code: "INVALID_SUBTITLE", message: "partial subtitles use the fixed fail-safe lifetime" };
  }
  const defaultHoldMs = speech ? 1_800 : 2_200;
  const holdMs = command.holdMs ?? defaultHoldMs;
  if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > MAX_SUBTITLE_HOLD_MS) {
    return { ok: false, code: "INVALID_SUBTITLE", message: "subtitle holdMs is out of bounds" };
  }
  return { ok: true, value: { turnId: command.turnId, revision: command.revision, text, final: command.final, holdMs } };
}

function retiredWith(retired, turnId) {
  if (!turnId || retired.includes(turnId)) return retired;
  return [...retired, turnId];
}

function nextLane(current, retired, payload, receivedAtMs) {
  if (retired.includes(payload.turnId)) {
    return { ok: false, code: "RETIRED_TURN", message: "an older subtitle turn cannot reappear" };
  }
  if (current?.turnId === payload.turnId && payload.revision <= current.revision) {
    return { ok: false, code: "STALE_REVISION", message: "subtitle revision must increase" };
  }
  if (
    current?.turnId !== payload.turnId
    && retired.length + (current ? 1 : 0) >= MAX_TURNS_PER_LANE
  ) {
    return { ok: false, code: "TURN_LIMIT", message: "subtitle generation reached its bounded turn limit" };
  }
  const nextRetired = current && current.turnId !== payload.turnId
    ? retiredWith(retired, current.turnId)
    : retired;
  let expiresAtMs;
  if (payload.final) {
    expiresAtMs = receivedAtMs + payload.holdMs;
  } else {
    expiresAtMs = receivedAtMs + PARTIAL_SUBTITLE_TTL_MS;
  }
  if (expiresAtMs !== null && expiresAtMs > MAX_TIMELINE_MS) {
    return { ok: false, code: "TIMELINE_OVERFLOW", message: "subtitle expiry exceeds the renderer generation" };
  }
  return {
    ok: true,
    lane: {
      turnId: payload.turnId,
      revision: payload.revision,
      text: payload.text,
      final: payload.final,
      receivedAtMs,
      expiresAtMs,
    },
    retired: nextRetired,
  };
}

function createSubtitleState({ nowMs = 0 } = {}) {
  if (!validTime(nowMs)) throw new RangeError("nowMs must be a bounded monotonic millisecond value");
  return canonicalState({
    schemaVersion: 1,
    nowMs,
    listening: null,
    speech: null,
    retired: { listening: [], speech: [] },
  });
}

function prepareCommand(state, command, receivedAtMs) {
  if (!CANONICAL_STATES.has(state)) {
    return { result: failure(state, "INVALID_STATE", "subtitle state must be canonical") };
  }
  if (!validTime(receivedAtMs)) {
    return { result: failure(state, "TRUSTED_TIME_REQUIRED", "receiver-supplied monotonic time is required") };
  }
  if (receivedAtMs < state.nowMs) {
    return { result: failure(state, "STALE_RECEIVER_TIME", "subtitle receiver time cannot move backwards") };
  }
  const safeCommand = snapshotRecord(command);
  if (!safeCommand) {
    return { result: failure(state, "INVALID_SUBTITLE", "subtitle command must be a plain object") };
  }
  if (safeCommand.type === "requestTool" || safeCommand.type === "eval" || safeCommand.type === "exec") {
    return { result: failure(state, "POLICY_REJECTED", "tool and code commands cannot enter the subtitle layer") };
  }
  return { command: safeCommand };
}

function applyKnownLane(state, command, lane, receivedAtMs) {
  if (command.clear === true) {
    if (!exactFields(command, ["type", "clear", "turnId", "revision"])) {
      return failure(state, "INVALID_SUBTITLE", "clear subtitle contains unknown fields");
    }
    const current = state[lane];
    if (!current) {
      return failure(state, "ALREADY_CLEAR", "subtitle lane is already clear");
    }
    if (
      typeof command.turnId !== "string"
      || !Number.isSafeInteger(command.revision)
      || command.turnId !== current.turnId
      || command.revision !== current.revision + 1
    ) {
      return failure(state, "STALE_CLEAR", "clear must target the exact current turn and next revision");
    }
    const next = canonicalState({
      ...state,
      nowMs: receivedAtMs,
      [lane]: null,
      retired: {
        ...state.retired,
        [lane]: retiredWith(state.retired[lane], current?.turnId),
      },
    });
    return success(next, lane, "cleared");
  }
  if (Object.hasOwn(command, "clear")) {
    return failure(state, "INVALID_SUBTITLE", "clear must be exactly true when present");
  }

  const validated = validatePayload(command, lane);
  if (!validated.ok) return failure(state, validated.code, validated.message);
  const updated = nextLane(state[lane], state.retired[lane], validated.value, receivedAtMs);
  if (!updated.ok) return failure(state, updated.code, updated.message);
  const next = canonicalState({
    ...state,
    nowMs: receivedAtMs,
    [lane]: updated.lane,
    retired: { ...state.retired, [lane]: updated.retired },
  });
  return success(next, lane);
}

function applySubtitleCommand(state, command, { receivedAtMs } = {}) {
  const prepared = prepareCommand(state, command, receivedAtMs);
  if (prepared.result) return prepared.result;
  if (prepared.command.type !== "setCaption") {
    return failure(state, "UNKNOWN_SUBTITLE_COMMAND", "command is not a public subtitle capability");
  }
  return applyKnownLane(state, prepared.command, "listening", receivedAtMs);
}

function createSpeechCaptionAuthority() {
  return Object.freeze({
    apply(state, command, { receivedAtMs } = {}) {
      const prepared = prepareCommand(state, command, receivedAtMs);
      if (prepared.result) return prepared.result;
      if (prepared.command.type !== "setSpeechCaption") {
        return failure(state, "UNKNOWN_SUBTITLE_COMMAND", "command is not a trusted speech subtitle capability");
      }
      return applyKnownLane(state, prepared.command, "speech", receivedAtMs);
    },
  });
}

function rollingText(text, maximumGraphemes) {
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
  if (graphemes.length <= maximumGraphemes) return text;
  return `…${graphemes.slice(-(maximumGraphemes - 1)).join("")}`;
}

function visibleLane(lane, nowMs, label, maximumGraphemes) {
  if (!lane || nowMs >= lane.expiresAtMs) return null;
  return { final: lane.final, label, text: rollingText(lane.text, maximumGraphemes) };
}

function deriveSubtitleFrame(state, nowMs = state?.nowMs) {
  if (!CANONICAL_STATES.has(state)) throw new TypeError("subtitle state must be canonical");
  if (!validTime(nowMs)) throw new RangeError("nowMs must be a bounded monotonic millisecond value");
  if (nowMs < state.nowMs) throw new RangeError("subtitle frame time cannot move backwards");
  return deepFreeze({
    speech: visibleLane(state.speech, nowMs, "SPEECH · SPEAKING", VISIBLE_SPEECH_GRAPHEMES),
    listening: visibleLane(state.listening, nowMs, "INPUT · LISTENING", VISIBLE_LISTENING_GRAPHEMES),
  });
}

function nextSubtitleExpiry(state, nowMs = state?.nowMs) {
  if (!CANONICAL_STATES.has(state)) throw new TypeError("subtitle state must be canonical");
  if (!validTime(nowMs) || nowMs < state.nowMs) {
    throw new RangeError("subtitle expiry time cannot move backwards or leave the generation");
  }
  const future = [state.listening?.expiresAtMs, state.speech?.expiresAtMs]
    .filter((value) => Number.isSafeInteger(value) && value > nowMs);
  return future.length > 0 ? Math.min(...future) : null;
}
global.CaptionCore = Object.freeze({ MAX_TIMELINE_MS, MAX_SUBTITLE_TEXT_LENGTH, MAX_SUBTITLE_HOLD_MS, PARTIAL_SUBTITLE_TTL_MS, createSubtitleState, applySubtitleCommand, createSpeechCaptionAuthority, deriveSubtitleFrame, nextSubtitleExpiry });
})(globalThis);
