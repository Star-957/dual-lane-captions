(function attachSubtitleDemo(global) {
  "use strict";

  function createView(elements) {
    const required = ["speech", "speechLabel", "listening", "listeningLabel"];
    if (!elements || required.some((key) => !elements[key])) {
      throw new TypeError("all caption elements are required");
    }
    function paint(text, label, lane) {
      text.textContent = lane?.text ?? "";
      label.textContent = lane?.label ?? "";
      text.hidden = !lane;
      label.hidden = !lane;
      text.dataset.final = lane ? String(lane.final) : "";
    }
    return {
      render(frame) {
        paint(elements.speech, elements.speechLabel, frame?.speech);
        paint(elements.listening, elements.listeningLabel, frame?.listening);
      },
    };
  }

  function createDemo(render) {
    if (typeof render !== "function") throw new TypeError("render callback required");
    const core = global.CaptionCore;
    const speech = core.createSpeechCaptionAuthority();
    let state = core.createSubtitleState();
    let now = 0;
    let turn = 0;
    let revision = 0;
    function publish(note) {
      const frame = core.deriveSubtitleFrame(state, now);
      render(frame, note, now);
      return { frame, note, now };
    }
    function apply(command, trusted = false) {
      const result = trusted
        ? speech.apply(state, command, { receivedAtMs: now })
        : core.applySubtitleCommand(state, command, { receivedAtMs: now });
      if (result.ok) state = result.state;
      return result;
    }
    const actions = {
      show() {
        now += 100;
        turn += 1;
        revision = 1;
        const first = apply({ type: "setCaption", turnId: `input-${turn}`, revision,
          text: "When is the next train?", final: false });
        const second = apply({ type: "setSpeechCaption", turnId: `output-${turn}`, revision: 1,
          text: "The next train leaves in five minutes.", final: true, holdMs: 1_800 }, true);
        return publish(first.ok && second.ok ? "Accepted two independent captions."
          : `Rejected: ${(first.ok ? second : first).error.code}`);
      },
      update() {
        if (!turn) return publish("Show a sample first.");
        now += 100;
        revision += 1;
        const result = apply({ type: "setCaption", turnId: `input-${turn}`, revision,
          text: "Which platform should I use?", final: false });
        return publish(result.ok ? `Accepted listening revision ${revision}.` : result.error.code);
      },
      stale() {
        if (!turn) return publish("Show a sample first.");
        now += 100;
        const result = apply({ type: "setCaption", turnId: `input-${turn}`, revision,
          text: "This stale text must not replace the accepted line.", final: false });
        return publish(result.ok ? "Unexpected acceptance." : `Rejected: ${result.error.code}`);
      },
      expire() {
        now += 20_000;
        return publish("Advanced receiver time; expired captions are hidden.");
      },
      reset() {
        state = core.createSubtitleState();
        now = 0;
        turn = 0;
        revision = 0;
        return publish("Reset to an empty state.");
      },
    };
    publish("Ready. Show a sample to begin.");
    return Object.freeze(actions);
  }

  global.SubtitleDemo = Object.freeze({ createView, createDemo });
  if (typeof document === "undefined") return;
  const view = createView({
    speech: document.getElementById("speech-text"),
    speechLabel: document.getElementById("speech-label"),
    listening: document.getElementById("listening-text"),
    listeningLabel: document.getElementById("listening-label"),
  });
  const demo = createDemo((frame, note, now) => {
    view.render(frame);
    document.getElementById("status").textContent = note;
    document.getElementById("clock").textContent = `Clock: ${now} ms`;
  });
  for (const action of ["show", "update", "stale", "expire", "reset"]) {
    document.getElementById(action).addEventListener("click", () => demo[action]());
  }
})(globalThis);
