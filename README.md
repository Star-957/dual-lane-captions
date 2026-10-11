# Dual-lane captions

An isolated caption state machine with separate **speech** and **listening** lanes.
It provides bounded text, monotonically increasing revisions, receiver-owned
expiry, replay rejection, and grapheme-safe visible text. A Node.js bridge adds
serialized asynchronous rendering, generation checks, and bounded scheduling.

Released under the [MIT License](LICENSE). See
[LICENSE-STATUS.md](LICENSE-STATUS.md) for dependency and distribution notes.
This is a source-folder release; `private: true` keeps npm publication disabled.

## Contents and requirements

- `src/subtitle-controller.mjs`: immutable, data-only caption reduction and frames.
- `src/plain-record-snapshot.mjs`: rejects accessors and unsupported record shapes.
- `src/timeline.mjs`: the bounded monotonic timeline shared by the modules.
- `src/caption-bridge.mjs`: Node-only asynchronous bridge; accepts caller-supplied
  data and callbacks. It does not read a speaking-state file or conversation log.
- `tests/`: extracted regression cases and anonymous demo checks.
- `demo/`: a local HTML demo with synthetic text and a manually advanced clock.
  `core.js` is a browser bundle derived from the three browser-compatible modules;
  the test suite verifies that it matches those sources.

Use Node.js 24 or newer and its bundled npm. There are **zero external package
dependencies**. No account, API key, model, asset download, build tool, or SDK is
required. No installation scripts are defined.

## Reproduce

From a fresh copy of this folder:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run verify:release
npm run build:demo
npm test
npm run verify:release
```

The lockfile contains only this package. The first command validates the install
workflow without fetching external packages. Test-generated temporary data is
not required. Test evidence for this release is described under Verification.
The final verification also checks that the build reproduced the included bundle
without changing the reviewed file hashes.

## Anonymous demo

Open `demo/index.html` in a current browser, or serve the demo directory with a
local static server. It uses adjacent classic scripts and styles and requires no
account, microphone, browser storage or external service. The buttons run the
actual bundled reducer:

1. **Show sample** adds one speech and one listening caption.
2. **Update partial** changes only the listening revision.
3. **Try stale update** demonstrates rejection without replacing accepted text.
4. **Advance 20 seconds** expires both captions using receiver time.
5. **Reset** creates a fresh state.

All examples are synthetic. This is a deterministic state / DOM demonstration,
not an audio-transcription or speech-synthesis application. The demo uses
`textContent` to paint captions; text must not be inserted as HTML by a consumer.
After changing the browser-compatible core, regenerate the demo with
`npm run build:demo`; the generator reads only the three named source modules and
writes `demo/core.js`. The bundled output is included so a reviewer need not run
a build or a local server to open the demo.

## Controller example

```js
import {
  createSubtitleState,
  applySubtitleCommand,
  deriveSubtitleFrame,
} from './src/subtitle-controller.mjs';

let state = createSubtitleState({ nowMs: 0 });
const result = applySubtitleCommand(state, {
  type: 'setCaption',
  turnId: 'example-1',
  revision: 1,
  text: 'Synthetic listening caption.',
  final: false,
}, { receivedAtMs: 100 });
if (result.ok) state = result.state;
console.log(deriveSubtitleFrame(state, 100).listening);
```

Public `setCaption` commands affect only `listening`. Speech changes use the
separate `createSpeechCaptionAuthority().apply(...)` capability with
`type: 'setSpeechCaption'`. The host must keep that capability inside its trusted
code. Exporting the function is not network authentication or a sandbox.

Each command needs a nonempty turn ID, increasing positive integer revision,
bounded text and a boolean `final`. Final captions may set `holdMs` from 1 to
10,000; partials expire after 15,000 ms. A clear command must name the current
turn and exactly the next revision. States come from `createSubtitleState` or a
successful reduction and cannot be reconstructed by parsing arbitrary JSON.

Time is receiver-supplied monotonic integer milliseconds. The maximum generation
is seven days, with earlier rotation required when bounds are approached.
The visible speech / listening windows contain at most 36 / 30 grapheme clusters.
Internal speech-control markers such as `[emo:...]` and `[hand:...]` are rejected.

## Node bridge

`CaptionBridge` from `src/caption-bridge.mjs` accepts optional `now`, `epochNow`,
`render`, `schedule`, and `cancel` callbacks. `apply()` requires the current
`bridge.generation`; `frame()` returns the derived view. The only advertised
public capability is `setCaption`.

`applySpeakingFlag({text, until, recent})` is a trusted host entry point accepting
an in-memory speaking-state object. `recent` may contain at most five
`{text, start, until}` records. The host supplies already approved speech text;
this method does not discover files, connect to another application, or determine
who is allowed to speak. The legacy state shape without `recent` has a weaker,
bounded replay window, not an authoritative event identity.

For legacy snapshots, a distinct active sentence can follow an expired sentence
even if the host missed the blank stop snapshot. The previous `until` must have
passed on the epoch clock; a different unsequenced sentence cannot replace one
that is still active. Repeating identical legacy text cannot identify a new
occurrence reliably. Use authoritative `recent` entries when that distinction
matters. Retired legacy signatures are bounded to the most recent 32.

Repeating an unchanged event/lifetime does not advance its stop-acceptance
watermark, including when its visible hold has expired and is repainted. A real
lifetime extension advances that watermark and keeps superseded deadlines
retired, so stale stops from before the extension remain rejected.

Call and **await `dispose()` before replacing a bridge that owns a shared
display**:

```js
await oldBridge.dispose();
const replacement = new CaptionBridge({ render: paintCaptions });
```

Disposal immediately invalidates the expiry callback and rejects new or queued
operations with `BRIDGE_DISPOSED`. A render already in progress may finish; the
returned promise waits for it and its recovery work, without arming more timers.
Repeated disposal returns the same promise. Disposal does not paint an empty
frame, erase caption data, or transfer state. Cancellation is best effort; a
leaked old callback cannot repaint after disposal. Calling `dispose()` from a
renderer or scheduler callback is rejected to avoid waiting on itself. Trusted
renderers must return a promise for all their display work; fire-and-forget work
cannot be drained, and a renderer that never settles prevents handover.
`frame()` remains available for inspecting the disposed instance's own state.

`generation` is **instance-local**: each new bridge starts at 1. It rejects old
generations within one instance, but an old generation-1 packet can be accepted
by a fresh instance. Hosts carrying packets across reconnects or replacements
must attach a separate session identity and reject mismatched sessions before
calling `apply()`. Dispose the old instance before switching the display owner.
Neither generation nor a session tag authenticates an untrusted sender.

The bridge uses `node:async_hooks`, so it is not browser-importable. Renderer and
scheduler callbacks are trusted application code. It is not a PII scrubber, a
production integration, or a guarantee that arbitrary callbacks are safe.

## Verification

Validated on 2026-10-11 using Windows x64, Node.js 24.18.1 and npm 11.16.0:

- A fresh copy of the exact allowlist installed offline with an initially empty
  npm cache, empty user/global npm configuration and lifecycle scripts disabled.
- All **87 tests passed**, with zero failures, skips or cancellations. These
  include five demo tests for the generated bundle, safe text rendering, button
  wiring, independent caption updates, revision rejection and expiry.
- Eight added regression/boundary tests cover missed legacy stops, delayed
  stops after unchanged polls/redraws, real lifetime extensions, disposal with
  failed cancellation, active/queued rendering, reentrant disposal, and the
  host's session boundary. Seven failed against the initial bridge before the
  fixes; the explicit instance-local generation boundary already passed.
- Rebuilding `demo/core.js` reproduced the included bytes. The staged source
  files also matched their reviewed hashes after installation, build and tests.
- Release-only pattern screening found no private project identifiers,
  personal paths, email addresses or credential-shaped values. Source and
  fixture inspection found only generic examples and Node.js
  built-in / relative imports. Pattern screening is not proof of anonymity.

For the initial release, the unchanged demo was exercised in a real Chrome browser on Windows over loopback
HTTP, at 1280 x 900, 390 x 844 and 320 x 800 viewports. The five actions worked
with both pointer and keyboard input; Tab followed the displayed control order.
Captions and controls remained readable without horizontal overflow. The page
exposes named buttons, a polite atomic caption region and a status region.
Text and keyboard-focus colors were checked for contrast, including the footer.
An intentional same-origin fetch was blocked by `connect-src 'none'`, confirming
that the browser enforced the demo's connection policy.

The five automated demo tests use Node's VM and fake DOM elements. The separate
browser checks cover the stated interactions and viewport sizes; they are not a
full accessibility certification. Screen-reader audio, Firefox, Safari and
direct-file browser behavior were not part of that browser run.
No new browser run is claimed for the Node-only bridge repair.

Existing private-project totals are not counted as release test evidence.
No source repository history, local hooks, credentials, conversations, character
identity, model assets or historical screenshots are part of the allowlist.

## Reviewed distribution boundary

The exact file allowlist is recorded in `scripts/verify-release.mjs` and mirrored
in `package.json`. `RELEASE-MANIFEST.json` records sizes and SHA-256 hashes for
each file except itself. `npm run verify:release` rejects missing, changed,
unreviewed or linked files and checks the MIT license / npm-publication guards.
Development `.git` and `node_modules` directories are excluded from traversal;
neither is part of the distribution. Unexpected directories are rejected too.

The GitHub distribution contains all 21 allowlisted files, including
the lockfile and Git text settings. This is a standalone source-folder release;
it is not an npm tarball. Npm's own pack rules omit some Git metadata files and
the lockfile, so `npm pack` is not the delivery format for this release.

Copy or archive only the exact allowlist. `.gitignore` helps avoid common local
artifacts but is not a privacy boundary. The hash manifest detects accidental
changes; it is not a signature, a secret scanner or proof of ownership.

After an intentional reviewed edit, run the build and tests before using
`npm run refresh:manifest`, then verify again. Do not refresh merely to silence an
unexpected mismatch. Keep the license and any applicable notices with copies of
the source, and review newly added files before widening the distribution.
