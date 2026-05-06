# Changelog

All notable changes to Threelane will be listed here. This file
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). When
cutting a release, the release workflow picks the topmost `## [x.y.z]`
section and uses it verbatim as the GitHub Release body.

## [0.2.1] - 2026-04-25

Linux support lands alongside two export-path fixes caught while
smoke-testing v0.2.0.

### Editor

- **Fixed export crash on scenes with cursor-follow enabled.** The
  v0.2.0 exporter sub-sampled each follow block at 200 ms ticks and
  built one `split`+`trim`+`scale`+`overlay` sub-chain per sample —
  long follow scenes blew that out to 5000+ filters plus a
  thousand-way `split`, exhausting ffmpeg's filter-graph allocator
  mid-render with `Failed to configure output pad on Parsed_scale_N
  / Error reinitializing filters / Resource temporarily unavailable`.
  Replaced the per-sample fanout with one `scale` + one `overlay`
  per zoom-clip block; cursor waypoints now drive the overlay's x/y
  via an in-chain `sendcmd`, riding the 30 fps scaled-video stream so
  commands fire at output frame rate. Filter count is now linear in
  zoom clips (typically ≤10), not in sample count, and panning reads
  smoother than v0.2.0 since every output frame gets its own position.
- **Circular bubble in exported MP4.** The editor preview already
  rendered the picture-in-picture bubble as a circle; the exporter
  had been leaving it square. Now uses a `geq`-painted alpha mask so
  exported videos match the preview, including the ~2 px white ring
  border the preview draws.

### Distribution

- **Linux AppImage (x64)** added to the release matrix. Single-file
  portable binary — `chmod +x Threelane-<version>.AppImage` and run.
  No code signing on Linux (not a convention). On Wayland sessions
  (Ubuntu 22+, Fedora 36+) screen capture goes through
  xdg-desktop-portal, so users see a "pick a screen" prompt once per
  session; X11 sessions capture silently. Cursor tracking works on
  both.

## [0.2.0] - 2026-04-23

First cross-platform release. macOS (arm64 + x64) and Windows (x64)
installers are built by GitHub Actions on tag push.

### Editor

- **Zoom lane** — drop per-clip zoom effects directly on a dedicated
  timeline lane. Drag either edge to resize, drag the body to move.
  Each clip carries its own zoom factor and follow-cursor toggle,
  replacing the old per-scene zoom model.
- **Trim lane** — mark cut ranges on their own lane. The preview
  playhead skips them, and the exporter omits them from the output MP4
  by pre-splitting the scene into trim-free sub-scenes. Zoom clips are
  clamped or dropped to match the surviving ranges.
- **Scene-level cursor follow** with exponential smoothing (α = 0.25)
  for motion continuity across zoom transitions; per-clip follow
  overrides the scene default.
- **Timeline alignment** — the ruler, scene blocks, zoom/trim pills,
  and the playhead now share the same horizontal coordinate system.
  Clicking a ruler tick seeks to exactly where the scene block
  underneath it starts.
- **Monitor volume + mute** in the transport bar. Preview-only — the
  exported MP4 is unaffected. Level and mute state persist in
  localStorage so the editor reopens at the same level next session.
- Renamed the transport "Delete scene" button to **Delete split** —
  it only ever removed the selected split, not the whole scene record.
- Fixed cursor tracking on multi-display setups — samples are now
  anchored to the correct display bounds rather than the primary
  display.

### Mobile companion

- **Front / back camera flip** button on the phone preview. Swaps
  `facingMode` and uses `RTCRtpSender.replaceTrack` so the laptop's
  live preview keeps flowing without renegotiating the peer
  connection. Disabled during recording (MediaRecorder is welded to
  its original tracks).

### Distribution

- **GitHub Actions release workflow** builds macOS and Windows
  installers on every `v*` tag push. Aggregates artifacts into a
  draft GitHub Release for manual review before publishing.
  `workflow_dispatch` is available for pipeline smoke-tests without
  tagging a release.
- Windows NSIS installer (x64), with directory picker and Start-menu
  shortcut. **Unsigned** — SmartScreen will warn on first launch
  until an EV cert is in place; click "More info → Run anyway".
- macOS bundles remain ad-hoc signed — users right-click → Open on
  first launch, after which TCC remembers camera/mic permission.

## [0.1.0] - Initial prototype

Single-platform macOS build, local electron-builder only. Screen +
multi-cam recording, per-input file storage, and the initial editor
with per-scene zoom. Tracked informally before this changelog existed.
