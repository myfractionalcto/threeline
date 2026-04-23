import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * Per-recording project folder on disk. One append-only WriteStream per
 * track — MediaRecorder emits webm chunks every second, we append them
 * in order, so the final file is a valid webm with no post-processing.
 */

export interface ProjectInfo {
  id: string;
  dir: string;
}

const streams = new Map<string, fs.WriteStream>(); // key = projectId/trackId

function projectsRoot(): string {
  // User-visible recordings go into ~/Movies/Threelane/. Mirrors the
  // editor-side projectsRoot() in editor/projects.ts.
  return path.join(app.getPath('home'), 'Movies', 'Threelane');
}

function streamKey(projectId: string, trackId: string) {
  return `${projectId}/${trackId}`;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'bin';
}

export async function createProject(): Promise<ProjectInfo> {
  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(projectsRoot(), id);
  await fsp.mkdir(dir, { recursive: true });
  return { id, dir };
}

export function projectDir(id: string): string {
  return path.join(projectsRoot(), id);
}

export async function appendChunk(
  projectId: string,
  trackId: string,
  mimeType: string,
  chunk: ArrayBuffer,
): Promise<void> {
  const k = streamKey(projectId, trackId);
  let stream = streams.get(k);
  if (!stream) {
    const file = path.join(projectDir(projectId), `${trackId}.${extFor(mimeType)}`);
    stream = fs.createWriteStream(file, { flags: 'a' });
    streams.set(k, stream);
  }
  // Buffer from Uint8Array view so no copy is needed.
  const buf = Buffer.from(chunk);
  await new Promise<void>((resolve, reject) => {
    stream!.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

export async function finalizeTrack(
  projectId: string,
  trackId: string,
): Promise<string> {
  const k = streamKey(projectId, trackId);
  const stream = streams.get(k);
  if (!stream) {
    // May happen if the track wrote nothing.
    return '';
  }
  await new Promise<void>((resolve, reject) => {
    stream.end((err: unknown) => (err ? reject(err) : resolve()));
  });
  streams.delete(k);
  // Manifest schema expects a bare filename (see types.ts:TrackManifestEntry.file).
  // Returning an absolute path here leaks into the manifest and breaks the
  // threelane-file:// URL encoding on the editor/export side.
  const dir = projectDir(projectId);
  const entries = await fsp.readdir(dir);
  const match = entries.find((e) => e.startsWith(`${trackId}.`));
  if (!match) return '';

  // Remux WebM so the editor can scrub it without stalling.
  //
  // MediaRecorder writes WebM on the fly: no duration in the EBML header,
  // no CUES (seek index) element. The <video> tag can play it forward but
  // seeking requires a linear scan — invisible on short clips, 1s+ stalls
  // on anything over ~60 seconds. Running ffmpeg with `-c copy` rewrites
  // the container with proper headers without re-encoding, so a 90s clip
  // takes ~100ms and seeking becomes instant afterwards.
  //
  // `.mp4` from the iPhone fallback path is already seekable; skip it.
  if (match.endsWith('.webm')) {
    const full = path.join(dir, match);
    const before = (await fsp.stat(full)).size;
    const t0 = Date.now();
    try {
      await remuxWebm(full);
      const after = (await fsp.stat(full)).size;
      console.log(
        `[storage] remux OK: ${match} ${before}B → ${after}B in ${Date.now() - t0}ms`,
      );
    } catch (e) {
      // Non-fatal: the raw file still plays, just slowly. We'd rather hand
      // the user a playable-but-sluggish recording than lose the take.
      console.warn(`[storage] remux of ${match} FAILED:`, e);
    }
  }
  return match;
}

/**
 * In-place WebM remux with `ffmpeg -c copy`. Writes to a sibling `.tmp.webm`
 * then atomically renames over the original to avoid half-written files if
 * the process is killed mid-way.
 */
async function remuxWebm(file: string): Promise<void> {
  if (!ffmpegPath) return;
  const bin = (ffmpegPath as unknown as string).replace(
    'app.asar',
    'app.asar.unpacked',
  );
  const tmp = file.replace(/\.webm$/, '.tmp.webm');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      bin,
      ['-y', '-fflags', '+genpts', '-i', file, '-c', 'copy', tmp],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg remux failed (${code}): ${stderr.slice(-400)}`));
    });
  });
  await fsp.rename(tmp, file);
}

export async function writeManifest(
  projectId: string,
  manifest: unknown,
): Promise<string> {
  const dir = projectDir(projectId);
  const file = path.join(dir, 'manifest.json');
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}
