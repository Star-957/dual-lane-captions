import { AsyncLocalStorage } from "node:async_hooks";

import { MAX_TIMELINE_MS } from "./timeline.mjs";
import { snapshotPlainRecord } from "./plain-record-snapshot.mjs";
import {
  MAX_SUBTITLE_HOLD_MS,
  MAX_SUBTITLE_TEXT_LENGTH,
  PARTIAL_SUBTITLE_TTL_MS,
  applySubtitleCommand,
  createSpeechCaptionAuthority,
  createSubtitleState,
  deriveSubtitleFrame,
  nextSubtitleExpiry,
} from "./subtitle-controller.mjs";

const CAPABILITIES = Object.freeze(["setCaption"]);
const ROTATION_HEADROOM_MS = Math.max(PARTIAL_SUBTITLE_TTL_MS, MAX_SUBTITLE_HOLD_MS) + 1_000;
const EXPIRY_RETRY_MS = 100;
const MAX_EXPIRY_RENDER_RETRIES = 3;
const MAX_EXPIRY_SCHEDULE_DRIFT_MS = 8;
const MAX_RETIRED_SPEECH_KEYS_AT_ONE_START = 32;
const MAX_PENDING_CAPTION_OPERATIONS = 128;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function snapshotRecent(value) {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) return null;
    const length = lengthDescriptor.value;
    if (value.length !== length) return null;
    if (!Number.isSafeInteger(length) || length < 0 || length > 5) return null;
    const keys = Reflect.ownKeys(value);
    const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;

    const recent = [];
    for (let index = 0; index < length; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!itemDescriptor || !Object.hasOwn(itemDescriptor, "value")) return null;
      const item = snapshotPlainRecord(itemDescriptor.value);
      if (!item) return null;
      const itemKeys = Object.keys(item);
      if (
        itemKeys.length !== 3
        || !itemKeys.every((key) => key === "text" || key === "start" || key === "until")
        || typeof item.text !== "string"
        || item.text.length < 1
        || item.text.length > MAX_SUBTITLE_TEXT_LENGTH
        || CONTROL_CHARACTERS.test(item.text)
        || !Number.isSafeInteger(item.start)
        || !Number.isSafeInteger(item.until)
        || item.start < 0
        || item.until < item.start
      ) {
        return null;
      }
      recent.push(Object.freeze({ text: item.text, start: item.start, until: item.until }));
    }
    return Object.freeze(recent);
  } catch {
    return null;
  }
}

function snapshotSpeakingFlag(flag) {
  const snapshot = snapshotPlainRecord(flag);
  if (!snapshot) return null;
  const keys = Object.keys(snapshot);
  if (
    keys.some((key) => key !== "until" && key !== "text" && key !== "recent")
    || !keys.includes("until")
    || !keys.includes("text")
    || !Number.isSafeInteger(snapshot.until)
    || snapshot.until < 0
    || typeof snapshot.text !== "string"
    || snapshot.text.length > MAX_SUBTITLE_TEXT_LENGTH
    || CONTROL_CHARACTERS.test(snapshot.text)
  ) {
    return null;
  }
  const recent = snapshotRecent(snapshot.recent);
  if (!recent) return null;
  return Object.freeze({ until: snapshot.until, text: snapshot.text, recent });
}

function matchingSpeechEvent(flag) {
  for (let index = flag.recent.length - 1; index >= 0; index -= 1) {
    const entry = flag.recent[index];
    if (entry.text === flag.text) {
      return speechEventAt(flag.recent, index);
    }
  }
  return null;
}

function speechEventAt(recent, index) {
  const entry = recent[index];
  let occurrenceOrdinal = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const candidate = recent[cursor];
    if (candidate.start === entry.start && candidate.text === entry.text) {
      occurrenceOrdinal += 1;
    }
  }
  return Object.freeze({
    text: entry.text,
    start: entry.start,
    until: entry.until,
    recentIndex: index,
    occurrenceOrdinal,
    synthetic: false,
  });
}

function matchingSpeechOccurrence(recent, event) {
  if (!event || event.synthetic) return null;
  for (let index = 0; index < recent.length; index += 1) {
    const candidate = recent[index];
    if (candidate.start !== event.start || candidate.text !== event.text) continue;
    const occurrence = speechEventAt(recent, index);
    if (occurrence.occurrenceOrdinal === event.occurrenceOrdinal) return occurrence;
  }
  return null;
}

function speechEventKey(event) {
  return `${event.start}\u0000${event.text}\u0000${event.occurrenceOrdinal ?? 1}`;
}

function sameSpeechEvent(left, right) {
  return Boolean(
    left
    && right
    && left.synthetic === right.synthetic
    && left.text === right.text
    && left.start === right.start
    && (
      left.synthetic
      || left.occurrenceOrdinal === right.occurrenceOrdinal
    )
  );
}

function speechFlagSignature(flag, event) {
  return event && !event.synthetic
    ? `event\u0000${speechEventKey(event)}\u0000${event.until}`
    : `legacy\u0000${flag.until}\u0000${flag.text}`;
}

function sameFrame(left, right) {
  return ["speech", "listening"].every((lane) => {
    const a = left[lane];
    const b = right[lane];
    return a === b || Boolean(
      a
      && b
      && a.final === b.final
      && a.label === b.label
      && a.text === b.text,
    );
  });
}

function defaultRawNow() {
  return Math.floor(globalThis.performance?.now?.() ?? 0);
}

function defaultSchedule(callback, delayMs) {
  return setTimeout(callback, delayMs);
}

function defaultCancel(handle) {
  clearTimeout(handle);
}

export class CaptionBridge {
  name = "caption-bridge";
  #state = createSubtitleState({ nowMs: 0 });
  #rawNow;
  #clockOrigin;
  #lastRawNow;
  #lastFrameNow = 0;
  #epochNow;
  #lastEpochNow = null;
  #render;
  #renderContext = new AsyncLocalStorage();
  #schedule;
  #cancel;
  #expiryHandle = null;
  #expiryToken = 0;
  #expirySerial = 0;
  #tail = Promise.resolve();
  #pendingOperations = 0;
  #speech = createSpeechCaptionAuthority();
  #generation = 1;
  #speakingFlagSignature = null;
  #speakingTurn = 0;
  #speakingRevision = 0;
  #speakingEvent = null;
  #speechHighWaterStart = null;
  #retiredSpeechKeysAtHighWater = new Set();
  #speechHighWaterSealed = false;
  #retiredSyntheticSignatures = new Set();

  constructor({
    now = defaultRawNow,
    epochNow = Date.now,
    render = () => undefined,
    schedule = defaultSchedule,
    cancel = defaultCancel,
  } = {}) {
    if (
      typeof now !== "function"
      || typeof epochNow !== "function"
      || typeof render !== "function"
      || typeof schedule !== "function"
      || typeof cancel !== "function"
    ) {
      throw new TypeError("now, epochNow, render, schedule, and cancel must be functions");
    }
    this.#rawNow = now;
    this.#epochNow = epochNow;
    this.#render = render;
    this.#schedule = schedule;
    this.#cancel = cancel;
    const initialRawNow = this.#readRawNow();
    this.#clockOrigin = initialRawNow;
  }

  get capabilities() {
    return new Set(CAPABILITIES);
  }

  get generation() {
    return this.#generation;
  }

  #readRawNow() {
    const value = this.#rawNow();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("caption monotonic clock must return a non-negative safe integer");
    }
    if (this.#lastRawNow !== undefined && value < this.#lastRawNow) {
      throw new RangeError("caption monotonic clock moved backwards");
    }
    this.#lastRawNow = value;
    return value;
  }

  #readEpochNow() {
    const value = this.#epochNow();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("caption epoch clock must return a non-negative safe integer");
    }
    if (this.#lastEpochNow !== null && value < this.#lastEpochNow) {
      throw new RangeError("caption epoch clock moved backwards");
    }
    this.#lastEpochNow = value;
    return value;
  }

  #prepareTime() {
    const rawNow = this.#readRawNow();
    const elapsed = Math.max(
      this.#state.nowMs,
      this.#lastFrameNow,
      rawNow - this.#clockOrigin,
    );
    return elapsed > MAX_TIMELINE_MS - ROTATION_HEADROOM_MS
      ? { nowMs: 0, rawNow, rotate: true }
      : { nowMs: elapsed, rawNow, rotate: false };
  }

  #frameTime() {
    const rawNow = this.#readRawNow();
    const nowMs = Math.min(
      MAX_TIMELINE_MS,
      Math.max(this.#state.nowMs, this.#lastFrameNow, rawNow - this.#clockOrigin),
    );
    this.#lastFrameNow = nowMs;
    return nowMs;
  }

  #enqueue(operation, { internal = false } = {}) {
    if (!internal && this.#pendingOperations >= MAX_PENDING_CAPTION_OPERATIONS) {
      return Promise.resolve({
        ok: false,
        note: `CAPTION_BUSY: at most ${MAX_PENDING_CAPTION_OPERATIONS} operations may be pending`,
      });
    }
    this.#pendingOperations += 1;
    const queued = this.#tail.then(operation, operation);
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued.then(
      (value) => {
        this.#pendingOperations -= 1;
        return value;
      },
      (error) => {
        this.#pendingOperations -= 1;
        throw error;
      },
    );
  }

  async #renderFrame(frame) {
    await this.#renderContext.run(this, () => this.#render(frame));
  }

  #cancelHandle(handle) {
    if (handle === null) return;
    try {
      this.#renderContext.run(this, () => this.#cancel(handle));
    } catch { /* timer token still invalidates a failed cancellation */ }
  }

  #invalidateExpiryToken(token) {
    if (token !== this.#expiryToken) return;
    const invalidated = this.#expirySerial + 1;
    this.#expirySerial = invalidated;
    this.#expiryToken = invalidated;
    this.#expiryHandle = null;
  }

  #queueExpiryRecovery() {
    const recovery = this.#enqueue(async () => {
      const timing = this.#prepareTime();
      if (timing.rotate) {
        await this.#commitEmptyRotation(timing);
        return;
      }
      let painted = await this.#paintStateUntilCurrent(this.#state, timing);
      if (!painted.rotated) {
        painted = await this.#replaceExpiryUntilCurrent(this.#state, painted);
      }
    }, { internal: true });
    return recovery.then(() => undefined, () => undefined);
  }

  #replaceExpiry(state, referenceNowMs, currentNowMs = referenceNowMs) {
    const expiresAtMs = nextSubtitleExpiry(state, referenceNowMs);
    const previousHandle = this.#expiryHandle;
    const token = this.#expirySerial + 1;
    this.#expirySerial = token;
    if (expiresAtMs === null) {
      this.#expiryToken = token;
      this.#expiryHandle = null;
      this.#cancelHandle(previousHandle);
      return { expiresAtMs: null, scheduledAtMs: currentNowMs };
    }

    let retryCount = 0;
    let callbackInFlight = false;
    let armInProgress = false;
    let firedDuringArm = false;
    const arm = (delayMs) => {
      let handle = null;
      armInProgress = true;
      firedDuringArm = false;
      try {
        this.#renderContext.run(this, () => {
          handle = this.#schedule(callback, delayMs);
          handle?.unref?.();
        });
      } catch (error) {
        this.#cancelHandle(handle);
        throw error;
      } finally {
        armInProgress = false;
      }
      if (firedDuringArm) {
        this.#cancelHandle(handle);
        throw new TypeError("caption scheduler callbacks must be asynchronous");
      }
      return handle;
    };
    const callback = () => {
      if (armInProgress) {
        firedDuringArm = true;
        return Promise.resolve();
      }
      if (token !== this.#expiryToken || callbackInFlight) return Promise.resolve();
      callbackInFlight = true;
      const expiry = this.#enqueue(async () => {
        if (token !== this.#expiryToken) return;
        const timing = this.#prepareTime();
        if (timing.rotate) {
          await this.#commitEmptyRotation(timing);
          return;
        }
        let painted = await this.#paintStateUntilCurrent(this.#state, timing);
        if (!painted.rotated && token === this.#expiryToken) {
          painted = await this.#replaceExpiryUntilCurrent(this.#state, painted);
        }
      }, { internal: true });
      return expiry.then(
        (value) => {
          callbackInFlight = false;
          return value;
        },
        async () => {
          try {
            if (token !== this.#expiryToken) return;
            if (retryCount >= MAX_EXPIRY_RENDER_RETRIES) {
              this.#invalidateExpiryToken(token);
              return;
            }
            retryCount += 1;
            try {
              const retryHandle = arm(EXPIRY_RETRY_MS);
              if (token === this.#expiryToken) this.#expiryHandle = retryHandle;
              else this.#cancelHandle(retryHandle);
            } catch {
              this.#invalidateExpiryToken(token);
              await this.#queueExpiryRecovery();
            }
          } finally {
            callbackInFlight = false;
          }
        },
      );
    };

    const nextHandle = arm(Math.max(0, expiresAtMs - currentNowMs));
    this.#expiryToken = token;
    this.#expiryHandle = nextHandle;
    this.#cancelHandle(previousHandle);
    return { expiresAtMs, scheduledAtMs: currentNowMs };
  }

  #retireSpeechEvent(event) {
    if (!event) return;
    if (event.synthetic) {
      this.#retiredSyntheticSignatures.delete(event.signature);
      this.#retiredSyntheticSignatures.add(event.signature);
      while (this.#retiredSyntheticSignatures.size > MAX_RETIRED_SPEECH_KEYS_AT_ONE_START) {
        const oldest = this.#retiredSyntheticSignatures.values().next().value;
        this.#retiredSyntheticSignatures.delete(oldest);
      }
      return;
    }
    if (this.#speechHighWaterStart === null || event.start > this.#speechHighWaterStart) {
      this.#speechHighWaterStart = event.start;
      this.#retiredSpeechKeysAtHighWater = new Set();
      this.#speechHighWaterSealed = false;
    }
    if (event.start !== this.#speechHighWaterStart) return;
    if (this.#retiredSpeechKeysAtHighWater.size >= MAX_RETIRED_SPEECH_KEYS_AT_ONE_START) {
      this.#speechHighWaterSealed = true;
      return;
    }
    this.#retiredSpeechKeysAtHighWater.add(speechEventKey(event));
  }

  #isRetiredSpeechEvent(event) {
    if (event.synthetic) {
      return this.#retiredSyntheticSignatures.has(event.signature);
    }
    if (this.#speechHighWaterStart === null) return false;
    if (event.start < this.#speechHighWaterStart) return true;
    if (event.start > this.#speechHighWaterStart) return false;
    return this.#speechHighWaterSealed
      || this.#retiredSpeechKeysAtHighWater.has(speechEventKey(event));
  }

  #retireExpiredRecentHistory(flag, epochNow) {
    const provenThrough = Math.min(flag.until, epochNow);
    for (const [recentIndex, entry] of flag.recent.entries()) {
      if (entry.until > provenThrough) continue;
      this.#retireSpeechEvent(speechEventAt(flag.recent, recentIndex));
    }
  }

  #commitSpeechEvent(event, epochNow, signature, previousEvent) {
    if (previousEvent?.synthetic && !event.synthetic) {
      this.#retireSpeechEvent(previousEvent);
    }
    if (!event.synthetic) {
      if (this.#speechHighWaterStart === null || event.start > this.#speechHighWaterStart) {
        this.#speechHighWaterStart = event.start;
        this.#retiredSpeechKeysAtHighWater = new Set();
        this.#speechHighWaterSealed = false;
      } else if (
        event.start === this.#speechHighWaterStart
        && previousEvent
        && !previousEvent.synthetic
        && speechEventKey(previousEvent) !== speechEventKey(event)
      ) {
        this.#retireSpeechEvent(previousEvent);
      }
    }
    const sameAcceptedEvent = sameSpeechEvent(event, previousEvent);
    const supersededUntils = sameAcceptedEvent
      ? [...(previousEvent.supersededUntils ?? [])]
      : [];
    let lifetimeHistorySealed = sameAcceptedEvent
      ? Boolean(previousEvent.lifetimeHistorySealed)
      : false;
    if (
      sameAcceptedEvent
      && event.until > previousEvent.until
      && !supersededUntils.includes(previousEvent.until)
    ) {
      if (supersededUntils.length >= MAX_RETIRED_SPEECH_KEYS_AT_ONE_START) {
        lifetimeHistorySealed = true;
      } else {
        supersededUntils.push(previousEvent.until);
      }
    }
    this.#speakingEvent = Object.freeze({
      ...event,
      observedAtEpoch: epochNow,
      signature,
      supersededUntils: Object.freeze(supersededUntils),
      lifetimeHistorySealed,
    });
    this.#speakingFlagSignature = signature;
  }

  async #rollbackVisual(timing) {
    let rollbackNow;
    try {
      rollbackNow = this.#frameTime();
    } catch {
      rollbackNow = Math.min(
        MAX_TIMELINE_MS,
        Math.max(this.#state.nowMs, this.#lastFrameNow, timing.rawNow - this.#clockOrigin),
      );
    }
    let paintedFrame = deriveSubtitleFrame(this.#state, rollbackNow);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.#renderFrame(paintedFrame);
      } catch {
        return rollbackNow;
      }
      let freshNow;
      try {
        freshNow = this.#frameTime();
      } catch {
        freshNow = Math.min(
          MAX_TIMELINE_MS,
          Math.max(this.#state.nowMs, this.#lastFrameNow, rollbackNow),
        );
      }
      const currentFrame = deriveSubtitleFrame(this.#state, freshNow);
      if (sameFrame(currentFrame, paintedFrame)) return freshNow;
      rollbackNow = freshNow;
      paintedFrame = currentFrame;
    }
    return rollbackNow;
  }

  #prospectiveRotationTime(clockOrigin) {
    const rawNow = this.#readRawNow();
    const elapsed = rawNow - clockOrigin;
    return elapsed > MAX_TIMELINE_MS - ROTATION_HEADROOM_MS
      ? { nowMs: 0, rawNow, rotate: true }
      : { nowMs: elapsed, rawNow, rotate: false };
  }

  async #paintStateUntilCurrent(
    state,
    timing,
    prospectiveClockOrigin = null,
    alreadyPaintedFrame = undefined,
  ) {
    let paintedFrame = deriveSubtitleFrame(state, timing.nowMs);
    if (alreadyPaintedFrame === undefined || !sameFrame(paintedFrame, alreadyPaintedFrame)) {
      try {
        await this.#renderFrame(paintedFrame);
      } catch (error) {
        await this.#rollbackVisual(timing);
        throw error;
      }
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let freshTiming;
      try {
        freshTiming = prospectiveClockOrigin === null
          ? this.#prepareTime()
          : this.#prospectiveRotationTime(prospectiveClockOrigin);
      } catch (error) {
        await this.#rollbackVisual(timing);
        throw error;
      }
      if (freshTiming.rotate) {
        await this.#commitEmptyRotation(freshTiming);
        return { rotated: true, timing: freshTiming, frame: deriveSubtitleFrame(this.#state, 0) };
      }
      const currentFrame = deriveSubtitleFrame(state, freshTiming.nowMs);
      if (sameFrame(currentFrame, paintedFrame)) {
        return { rotated: false, timing: freshTiming, frame: currentFrame };
      }
      try {
        await this.#renderFrame(currentFrame);
      } catch (error) {
        await this.#rollbackVisual(freshTiming);
        throw error;
      }
      paintedFrame = currentFrame;
    }

    const error = new Error("caption renderer could not reach a current frame");
    await this.#rollbackVisual(timing);
    throw error;
  }

  async #replaceExpiryUntilCurrent(state, painted, prospectiveClockOrigin = null) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expiryPlan = this.#replaceExpiry(
        state,
        painted.timing.nowMs,
        painted.timing.nowMs,
      );
      const priorFrame = painted.frame;
      painted = await this.#paintStateUntilCurrent(
        state,
        painted.timing,
        prospectiveClockOrigin,
        priorFrame,
      );
      const scheduleDriftMs = painted.timing.nowMs - expiryPlan.scheduledAtMs;
      const deadlineStable = expiryPlan.expiresAtMs === null
        || scheduleDriftMs <= MAX_EXPIRY_SCHEDULE_DRIFT_MS;
      if (
        painted.rotated
        || (sameFrame(priorFrame, painted.frame) && deadlineStable)
      ) {
        return painted;
      }
    }
    throw new Error("caption expiry scheduling could not reach a current frame");
  }

  async #restoreAcceptedStateAfterFailure(timing) {
    const rollbackNow = await this.#rollbackVisual(timing);
    try {
      const restorationTiming = this.#prepareTime();
      if (restorationTiming.rotate) {
        await this.#commitEmptyRotation(restorationTiming);
        return;
      }
      let painted = await this.#paintStateUntilCurrent(
        this.#state,
        restorationTiming,
        null,
        deriveSubtitleFrame(this.#state, rollbackNow),
      );
      if (!painted.rotated) {
        painted = await this.#replaceExpiryUntilCurrent(this.#state, painted);
      }
    } catch {
      const failedHandle = this.#expiryHandle;
      this.#invalidateExpiryToken(this.#expiryToken);
      this.#cancelHandle(failedHandle);
      await this.#rollbackVisual(timing);
    }
  }

  async #commitEmptyRotation(timing) {
    const empty = createSubtitleState({ nowMs: 0 });
    try {
      await this.#renderFrame(deriveSubtitleFrame(empty, 0));
    } catch (error) {
      await this.#rollbackVisual(timing);
      throw error;
    }
    try { this.#replaceExpiry(empty, 0, 0); } catch (error) {
      await this.#rollbackVisual(timing);
      throw error;
    }
    this.#clockOrigin = timing.rawNow;
    this.#state = empty;
    this.#lastFrameNow = 0;
    this.#generation += 1;
  }

  async #reduceAndRender(command, timing, trustedSpeech = false) {
    if (timing.rotate) {
      await this.#commitEmptyRotation(timing);
      return { ok: false, note: `GENERATION_ROTATED: expected ${this.#generation}` };
    }
    const reduce = trustedSpeech
      ? (state, input, options) => this.#speech.apply(state, input, options)
      : applySubtitleCommand;
    let rotated = false;
    let baseState = this.#state;
    let result = reduce(baseState, command, { receivedAtMs: timing.nowMs });
    if (!result.ok && result.error.code === "TURN_LIMIT") {
      rotated = true;
      timing = { rawNow: timing.rawNow, nowMs: 0, rotate: true };
      baseState = createSubtitleState({ nowMs: 0 });
      result = reduce(baseState, command, { receivedAtMs: 0 });
    }
    if (!result.ok) {
      return { ok: false, note: `${result.error.code}: ${result.error.message}` };
    }

    let painted = await this.#paintStateUntilCurrent(
      result.state,
      timing,
      rotated ? timing.rawNow : null,
    );
    if (painted.rotated) {
      return { ok: false, note: `GENERATION_ROTATED: expected ${this.#generation}` };
    }

    try {
      painted = await this.#replaceExpiryUntilCurrent(
        result.state,
        painted,
        rotated ? timing.rawNow : null,
      );
      if (painted.rotated) {
        return { ok: false, note: `GENERATION_ROTATED: expected ${this.#generation}` };
      }
    } catch (error) {
      await this.#restoreAcceptedStateAfterFailure(timing);
      throw error;
    }
    const commitNowMs = painted.timing.nowMs;
    if (rotated) {
      this.#clockOrigin = timing.rawNow;
      this.#lastFrameNow = 0;
      this.#generation += 1;
    }
    this.#state = result.state;
    this.#lastFrameNow = Math.max(this.#lastFrameNow, commitNowMs);
    if (result.operation === "cleared") {
      return {
        ok: true,
        note: result.lane === "speech" ? "speech caption cleared" : "listening caption cleared",
      };
    }
    return {
      ok: true,
      note: result.lane === "speech" ? "speech caption accepted" : "listening caption accepted",
    };
  }

  apply(command) {
    const safeCommand = snapshotPlainRecord(command);
    if (!safeCommand) return Promise.resolve({ ok: false, note: "invalid caption command" });
    Object.freeze(safeCommand);
    if (this.#renderContext.getStore() === this) {
      return Promise.resolve({ ok: false, note: "reentrant caption apply rejected" });
    }
    return this.#enqueue(() => {
      if (!Number.isSafeInteger(safeCommand.generation) || safeCommand.generation !== this.#generation) {
        return { ok: false, note: `STALE_GENERATION: expected ${this.#generation}` };
      }
      const payload = Object.create(null);
      for (const [key, value] of Object.entries(safeCommand)) {
        if (key !== "generation") payload[key] = value;
      }
      return this.#reduceAndRender(payload, this.#prepareTime(), false);
    });
  }

  applySpeakingFlag(flag) {
    const safeFlag = snapshotSpeakingFlag(flag);
    if (!safeFlag) return Promise.resolve({ ok: false, note: "invalid speaking flag" });
    if (this.#renderContext.getStore() === this) {
      return Promise.resolve({ ok: false, note: "reentrant speaking flag apply rejected" });
    }
    return this.#enqueue(() => this.#applySpeakingFlag(safeFlag));
  }

  async #applySpeakingFlag(flag) {
    let timing = this.#prepareTime();
    if (timing.rotate) {
      await this.#commitEmptyRotation(timing);
      timing = this.#prepareTime();
    }
    let epochNow;
    try { epochNow = this.#readEpochNow(); } catch (error) {
      return { ok: false, note: error.message };
    }

    const currentEvent = this.#speakingEvent;
    const hasText = Boolean(flag.text.trim());
    let nextEvent = hasText ? matchingSpeechEvent(flag) : null;
    if (nextEvent) {
      if (nextEvent.start > epochNow) {
        return { ok: false, note: "future speaking flag ignored" };
      }
      if (flag.until < nextEvent.until) {
        return { ok: false, note: "inconsistent speaking flag ignored" };
      }
    }

    if (hasText && nextEvent === null) {
      if (currentEvent?.synthetic && currentEvent.text === flag.text) {
        nextEvent = Object.freeze({
          text: flag.text,
          start: currentEvent.start,
          until: flag.until,
          recentIndex: -1,
          synthetic: true,
        });
      } else if (currentEvent === null && this.#speechHighWaterStart === null) {
        nextEvent = Object.freeze({
          text: flag.text,
          start: epochNow,
          until: flag.until,
          recentIndex: -1,
          synthetic: true,
        });
      } else {
        return { ok: false, note: "unsequenced speaking flag ignored" };
      }
    }

    const signature = speechFlagSignature(flag, nextEvent);
    const effectiveUntil = nextEvent?.until ?? flag.until;
    const inactive = !hasText || effectiveUntil <= epochNow;
    if (
      currentEvent === null
      && nextEvent
      && this.#isRetiredSpeechEvent({ ...nextEvent, signature })
    ) {
      return { ok: false, note: "stale speaking flag ignored" };
    }

    if (inactive) {
      if (currentEvent === null) {
        if (nextEvent) {
          this.#retireSpeechEvent({ ...nextEvent, signature });
        } else if (!hasText) {
          this.#retireExpiredRecentHistory(flag, epochNow);
        }
        this.#speakingFlagSignature = signature;
        return { ok: true, note: "speaking flag unchanged" };
      }

      let authorizedClear = false;
      if (!hasText) {
        if (currentEvent.synthetic) {
          authorizedClear = flag.until >= currentEvent.observedAtEpoch
            && flag.until <= epochNow
            && (
              flag.until >= currentEvent.until
              || (
                !currentEvent.lifetimeHistorySealed
                && !currentEvent.supersededUntils.includes(flag.until)
              )
            );
        } else {
          const clearEvidence = matchingSpeechOccurrence(flag.recent, currentEvent);
          authorizedClear = flag.until >= currentEvent.observedAtEpoch
            && flag.until <= epochNow
            && clearEvidence !== null
            && clearEvidence.until <= flag.until
            && (
              clearEvidence.until >= currentEvent.until
              || (
                clearEvidence.until === flag.until
                && !currentEvent.lifetimeHistorySealed
                && !currentEvent.supersededUntils.includes(clearEvidence.until)
              )
            );
        }
      } else if (currentEvent.synthetic) {
        authorizedClear = nextEvent?.synthetic
          && nextEvent.text === currentEvent.text
          && nextEvent.until >= currentEvent.until
          && nextEvent.until <= epochNow;
      } else {
        authorizedClear = nextEvent
          && sameSpeechEvent(nextEvent, currentEvent)
          && nextEvent.until >= currentEvent.until
          && nextEvent.until <= epochNow;
      }
      if (!authorizedClear) {
        return { ok: false, note: "stale speaking flag ignored" };
      }

      let cleared = { ok: true, note: "speech caption cleared" };
      if (this.#state.speech !== null) {
        cleared = await this.#reduceAndRender({
          type: "setSpeechCaption",
          clear: true,
          turnId: `speaking-flag-${this.#speakingTurn}`,
          revision: this.#speakingRevision + 1,
        }, timing, true);
      }
      if (!cleared.ok) return cleared;
      this.#retireSpeechEvent(currentEvent);
      this.#speakingFlagSignature = signature;
      this.#speakingRevision = 0;
      this.#speakingEvent = null;
      return cleared;
    }

    if (!nextEvent) {
      return { ok: false, note: "unsequenced speaking flag ignored" };
    }

    let sameEvent = false;
    if (currentEvent) {
      if (currentEvent.synthetic && !nextEvent.synthetic) {
        sameEvent = currentEvent.text === nextEvent.text;
      } else if (sameSpeechEvent(nextEvent, currentEvent)) {
        if (nextEvent.until < currentEvent.until) {
          return { ok: false, note: "stale speaking flag ignored" };
        }
        sameEvent = true;
      } else {
        if (currentEvent.synthetic || nextEvent.synthetic || nextEvent.start < currentEvent.start) {
          return { ok: false, note: "stale speaking flag ignored" };
        }
        if (nextEvent.start === currentEvent.start) {
          const currentOccurrence = matchingSpeechOccurrence(flag.recent, currentEvent);
          if (
            currentOccurrence === null
            || currentOccurrence.recentIndex >= nextEvent.recentIndex
          ) {
            return { ok: false, note: "ambiguous speaking flag ignored" };
          }
        }
        if (this.#isRetiredSpeechEvent(nextEvent)) {
          return { ok: false, note: "stale speaking flag ignored" };
        }
      }
    } else if (
      !nextEvent.synthetic
      && this.#speechHighWaterStart === nextEvent.start
      && this.#retiredSpeechKeysAtHighWater.size > 0
    ) {
      const followsRetired = flag.recent
        .slice(0, nextEvent.recentIndex)
        .some((entry, index) => (
          entry.start === nextEvent.start
          && this.#retiredSpeechKeysAtHighWater.has(speechEventKey(speechEventAt(flag.recent, index)))
        ));
      if (!followsRetired) {
        return { ok: false, note: "ambiguous speaking flag ignored" };
      }
    }

    if (
      currentEvent
      && sameEvent
      && nextEvent.until === currentEvent.until
      && signature === currentEvent.signature
      && deriveSubtitleFrame(this.#state, timing.nowMs).speech !== null
    ) {
      this.#commitSpeechEvent(nextEvent, epochNow, signature, currentEvent);
      return { ok: true, note: "speaking flag unchanged" };
    }

    const nextTurn = sameEvent ? this.#speakingTurn : this.#speakingTurn + 1;
    const nextRevision = sameEvent ? this.#speakingRevision + 1 : 1;
    const holdMs = Math.max(1, Math.min(MAX_SUBTITLE_HOLD_MS, effectiveUntil - epochNow + 1_100));
    const result = await this.#reduceAndRender({
      type: "setSpeechCaption",
      turnId: `speaking-flag-${nextTurn}`,
      revision: nextRevision,
      text: flag.text,
      final: true,
      holdMs,
    }, timing, true);
    if (!result.ok) return result;
    this.#speakingTurn = nextTurn;
    this.#speakingRevision = nextRevision;
    this.#commitSpeechEvent(nextEvent, epochNow, signature, currentEvent);
    return { ok: true, note: "speech speaking flag accepted" };
  }

  frame(nowMs) {
    if (this.#renderContext.getStore() === this) {
      throw new RangeError("reentrant caption frame rejected");
    }
    if (nowMs === undefined) return deriveSubtitleFrame(this.#state, this.#frameTime());
    if (!Number.isSafeInteger(nowMs) || nowMs < this.#lastFrameNow || nowMs > MAX_TIMELINE_MS) {
      throw new RangeError("explicit caption frame time cannot move backwards or leave the generation");
    }
    this.#lastFrameNow = nowMs;
    return deriveSubtitleFrame(this.#state, nowMs);
  }
}
