import { screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Records the global cursor position while the screen is being captured.
 * Electron's `screen.getCursorScreenPoint()` reports the cursor in
 * device-independent pixels on whichever display the cursor is on —
 * good enough for full-screen captures of the primary display (v1).
 *
 * File format: newline-delimited JSON. First line is a header with display
 * info; subsequent lines are `{ t, x, y }` samples at ~30 Hz, where `t` is
 * ms since recording start.
 */

const POLL_HZ = 30;

interface Tracker {
  stream: fs.WriteStream;
  timer: NodeJS.Timeout;
  startedAtMs: number;
}

const trackers = new Map<string, Tracker>();

/**
 * Parse the display id out of a desktopCapturer source id. On every
 * platform Electron exposes, screen sources are `screen:<displayId>:<windowIndex>`
 * where `<displayId>` matches Electron's `Display.id` (an integer).
 * Returns null if the caller didn't provide one or the format doesn't parse.
 */
function displayIdFromSource(sourceId: string | null): number | null {
  if (!sourceId) return null;
  const m = /^screen:(\d+):/.exec(sourceId);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

export async function startCursorTracking(
  projectId: string,
  projectDir: string,
  startedAtMs: number,
  screenSourceId: string | null,
): Promise<string> {
  // If already tracking (reentrant call), stop the old one cleanly.
  if (trackers.has(projectId)) {
    await stopCursorTracking(projectId);
  }
  const file = path.join(projectDir, 'cursor.jsonl');
  const stream = fs.createWriteStream(file, { flags: 'w' });

  // Pick the display that's actually being recorded. Falling back to the
  // primary display is wrong on multi-monitor setups — cursor samples are
  // in GLOBAL screen coordinates, so we need the recorded display's origin
  // (bounds.x/y) to make samples display-local, and we need to skip
  // samples that aren't on that display at all.
  const wantedId = displayIdFromSource(screenSourceId);
  const display =
    (wantedId != null
      ? screen.getAllDisplays().find((d) => d.id === wantedId)
      : undefined) ?? screen.getPrimaryDisplay();

  const header =
    JSON.stringify({
      kind: 'header',
      display: {
        bounds: display.bounds, // in DIP — includes x/y offset in multi-display setups
        size: display.size,
        scaleFactor: display.scaleFactor,
      },
      pollHz: POLL_HZ,
      startedAtMs,
    }) + '\n';
  stream.write(header);

  const bx = display.bounds.x;
  const by = display.bounds.y;
  const bw = display.bounds.width;
  const bh = display.bounds.height;

  const timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    // Make samples relative to the recorded display's origin. Skip when
    // the cursor is on another monitor — drawing a follow-target for a
    // point that isn't on the recorded screen would be meaningless.
    const x = p.x - bx;
    const y = p.y - by;
    if (x < 0 || y < 0 || x > bw || y > bh) return;
    const line = JSON.stringify({ t: Date.now() - startedAtMs, x, y }) + '\n';
    stream.write(line);
  }, Math.round(1000 / POLL_HZ));

  trackers.set(projectId, { stream, timer, startedAtMs });
  return 'cursor.jsonl';
}

export async function stopCursorTracking(projectId: string): Promise<string | null> {
  const t = trackers.get(projectId);
  if (!t) return null;
  clearInterval(t.timer);
  await new Promise<void>((resolve, reject) => {
    t.stream.end((err: unknown) => (err ? reject(err) : resolve()));
  });
  trackers.delete(projectId);
  return 'cursor.jsonl';
}

/**
 * Loads cursor.jsonl for a project and returns a normalized cursor track.
 * Missing file → returns null. Parse errors on individual lines are
 * skipped (we don't want one corrupt line to kill playback).
 */
export async function loadCursorTrack(projectDir: string): Promise<{
  display: { width: number; height: number; scaleFactor: number };
  samples: { t: number; x: number; y: number }[];
} | null> {
  const file = path.join(projectDir, 'cursor.jsonl');
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]);
    if (header.kind !== 'header') return null;
    const samples: { t: number; x: number; y: number }[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const s = JSON.parse(lines[i]);
        if (typeof s.t === 'number' && typeof s.x === 'number' && typeof s.y === 'number') {
          samples.push({ t: s.t, x: s.x, y: s.y });
        }
      } catch {
        // skip corrupt line
      }
    }
    return {
      display: {
        width: header.display.bounds.width,
        height: header.display.bounds.height,
        scaleFactor: header.display.scaleFactor,
      },
      samples,
    };
  } catch {
    return null;
  }
}
