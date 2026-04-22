<p align="center">
  <img src="public/favicon.svg" alt="Threelane" width="128" height="128" />
</p>

<h1 align="center">Threelane</h1>

<p align="center">
  Local screen + multi-cam recorder and reels/shorts editor for macOS.
</p>

<p align="center">
  <a href="https://threeline.myfractionalcto.com">Website</a> &nbsp;·&nbsp;
  <a href="../../releases/latest">Download</a> &nbsp;·&nbsp;
  <a href="https://myfractionalcto.slack.com">Slack</a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a> &nbsp;·&nbsp;
  <a href="PLAN.md">Architecture</a>
</p>

---

> **Status:** v0.1.0 — first public build. Records screen + webcam + mobile
> companion over WiFi, edits in a timeline, and exports to MP4. Expect rough
> edges; not code-signed yet.

## About

Threelane is a Mac app that captures your screen, webcam, and a phone-as-camera
simultaneously over the same WiFi network, then edits the tracks into
portrait or landscape reels with per-scene layouts and exports to MP4.

Everything runs locally on your laptop. Nothing is uploaded. The mobile
companion is an installable PWA served by the laptop, so there's no app
store install on the phone either.

More on the [website](https://threeline.myfractionalcto.com).

## Features

### Recording

- **Screen capture** — full screen or a single window, picked via a visual
  source picker.
- **Laptop webcam + microphone** — standard `getUserMedia` devices, selectable
  from the recorder panel. iPhone shows up here too via Continuity Camera.
- **Mobile phone as an extra camera** — pair by scanning a QR code; the phone
  runs an installable PWA in Safari or Chrome. No App Store install.
- **Per-input files, no pre-compositing** — each source writes its own WebM
  to disk (`screen.webm`, `laptop-cam.webm`, `mobile-<id>.webm`, etc.) so
  the editor can recompose layouts after the fact.
- **Cursor tracking data** — captured alongside the screen for future
  follow-cam effects.

### Editor

- **Multi-track timeline** with independent video and audio rows.
- **Frame-accurate scrubbing and seeking** — custom `threelane-file://`
  protocol handler serves HTTP Range requests so Chromium can seek inside
  WebM without rebuffering from zero.
- **Split / cut clips** at the playhead.
- **Keyboard shortcuts**: `Space` toggles playback, `Shift + ←/→` steps one
  second, `Shift + ⌘ + ←/→` steps five seconds, `⌘ + L` splits at the
  playhead.
- **Export to MP4** using bundled ffmpeg — no system install needed.

### Mobile companion

- **Installable PWA** — add to home screen on iOS or Android, launches
  full-screen.
- **Self-signed CA, one-tap trust** — the laptop generates a local
  certificate authority and serves a `.mobileconfig` for iOS so HTTPS works
  across your WiFi without warnings.
- **Offline-first shell** — service worker caches the app so the "Reconnect"
  UI still boots when WiFi drops.
- **QR pairing + manual URL fallback** — scan, paste, or reuse the last
  known URL.
- **Upload after stop** — phone footage transfers to the laptop project
  folder when you hit stop, so the editor sees all tracks together.

### Local-first, no cloud

- Projects live at `~/Movies/Threelane/<project>/`.
- Nothing is uploaded anywhere. No accounts, no telemetry, no servers.
- The companion server runs only while Threelane is open, only on your
  local network.

## Install

Grab the latest `.dmg` from the [Releases page](../../releases/latest):

- **Apple Silicon (M1/M2/M3/M4)** → `Threelane-<version>-arm64.dmg`
- **Intel Mac** → `Threelane-<version>.dmg`

Open the `.dmg` and drag **Threelane.app** to **Applications**.

### If macOS blocks the app

Threelane is not yet signed with an Apple Developer certificate, so macOS
Gatekeeper may refuse to open it on first launch ("damaged" or "cannot
verify developer"). Clear the quarantine flag with one Terminal command
after installing:

```bash
xattr -rd com.apple.quarantine /Applications/Threelane.app
```

Then launch Threelane normally. Alternatively, right-click Threelane.app
in Applications → **Open**, then click **Open** in the dialog
(double-clicking won't show the override button).

## Community

Questions, feedback, bug reports? Join the Slack:
[myfractionalcto.slack.com](https://myfractionalcto.slack.com)

Or open an issue on this repo.

## Develop

```bash
npm install
npm run dev      # starts Vite + Electron with hot reload
```

## Build an unsigned .dmg

```bash
npm run dist     # writes release/Threelane-<version>-<arch>.dmg
```

We'll add real code signing when there's an Apple Developer account on
the project — it's a flag-flip in `electron-builder.yml`.

## Layout

See [PLAN.md](PLAN.md) for the full architecture and milestone plan.
