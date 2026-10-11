/**
 * ENC upload + tiling service (server-side).
 *
 * Accepts an uploaded S-57 exchange set (a `.zip` — single cell or a region
 * bundle) and, in the background, unzips it, finds the ENC_ROOT (the folder that
 * holds CATALOG.031), and runs the `s57-tiler` binary to produce Mapbox vector
 * tiles into the charts-plugin's chart directory. The freshly tiled cells then
 * appear in the SignalK charts list (after the charts-plugin rescans).
 *
 * No extra npm dependencies: the upload body is streamed straight to disk and
 * `unzip` / `s57-tiler` are spawned as child processes (Linux host, matching the
 * s57-tiler binary that already lives on the box).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';

export interface ENC_CONFIG {
  enable: boolean;
  tilerPath: string; // path to the s57-tiler binary
  chartOutputPath: string; // where tiles are written (a charts-plugin chartPath)
  stagingPath: string; // scratch dir for uploads + extraction
  maxZoom: number; // cap tiling zoom (native zoom can be millions of tiles)
}

type JobStatus = 'queued' | 'extracting' | 'tiling' | 'done' | 'error';

interface Job {
  id: string;
  name: string; // uploaded filename
  status: JobStatus;
  message: string;
  cells: string[]; // cell ids produced
  log: string[]; // tail of tiler/unzip output
  startedAt: number;
  finishedAt?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;

let cfg: ENC_CONFIG;
let srv: Server;
const jobs = new Map<string, Job>();
let seq = 0;

const LOG_TAIL = 40;

export function initEnc(server: Server, config: ENC_CONFIG): void {
  srv = server;
  cfg = config;
  ensureDir(cfg.stagingPath);
  ensureDir(cfg.chartOutputPath);
  srv.debug(
    `[ENC] service ready — tiler=${cfg.tilerPath} out=${cfg.chartOutputPath} staging=${cfg.stagingPath} maxZoom=${cfg.maxZoom}`
  );
}

export function stopEnc(): void {
  jobs.clear();
}

function ensureDir(p: string): void {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
}

function pushLog(job: Job, line: string): void {
  const s = line.replace(/\s+$/, '');
  if (!s) return;
  job.log.push(s);
  if (job.log.length > LOG_TAIL) job.log.shift();
}

function publicJob(job: Job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    message: job.message,
    cells: job.cells,
    log: job.log,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

/** POST /enc/upload — stream the raw request body (a .zip) to disk, start a job. */
export function handleUpload(req: Request, res: Response): void {
  if (!cfg?.enable) {
    res.status(503).json({ error: 'ENC upload is disabled in the plugin config.' });
    return;
  }
  const rawName =
    (req.query.name as string) ||
    (req.header('x-filename') as string) ||
    `upload-${Date.now()}.zip`;
  const name = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!/\.zip$/i.test(name)) {
    res
      .status(400)
      .json({ error: 'Upload a .zip ENC exchange set (single cell or a region bundle).' });
    return;
  }

  const id = `enc-${Date.now()}-${++seq}`;
  const jobDir = path.join(cfg.stagingPath, id);
  ensureDir(jobDir);
  const zipPath = path.join(jobDir, name);

  const job: Job = {
    id,
    name,
    status: 'queued',
    message: 'Receiving upload…',
    cells: [],
    log: [],
    startedAt: Date.now()
  };
  jobs.set(id, job);

  const out = fs.createWriteStream(zipPath);
  req.pipe(out);
  out.on('finish', () => {
    srv.debug(`[ENC] upload stored: ${zipPath}`);
    // Kick off the background pipeline; respond immediately with the job id.
    runJob(job, jobDir, zipPath).catch((e) => {
      job.status = 'error';
      job.message = `Failed: ${e?.message ?? e}`;
      job.finishedAt = Date.now();
      srv.error(`[ENC] job ${id} failed: ${e?.stack ?? e}`);
    });
  });
  out.on('error', (e) => {
    job.status = 'error';
    job.message = `Upload failed: ${e.message}`;
    job.finishedAt = Date.now();
  });
  req.on('aborted', () => {
    out.destroy();
    job.status = 'error';
    job.message = 'Upload aborted by client.';
    job.finishedAt = Date.now();
  });

  res.status(202).json({ jobId: id, status: 'queued' });
}

export function getJob(req: Request, res: Response): void {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Unknown job id.' });
    return;
  }
  res.json(publicJob(job));
}

export function listJobs(_req: Request, res: Response): void {
  const list = Array.from(jobs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(publicJob);
  res.json({ jobs: list });
}

// ---- background pipeline -----------------------------------------------------

async function runJob(job: Job, jobDir: string, zipPath: string): Promise<void> {
  job.status = 'extracting';
  job.message = 'Extracting exchange set…';

  const encDir = path.join(jobDir, 'enc');
  ensureDir(encDir);
  await extractZip(zipPath, encDir, job);

  // Find the ENC_ROOT (the directory that contains CATALOG.031, any case).
  const root = findEncRoot(encDir);
  if (!root) {
    throw new Error('No CATALOG.031 found in the zip — not a valid S-57 exchange set.');
  }
  srv.debug(`[ENC] ENC_ROOT: ${root}`);

  const before = new Set(listCells(cfg.chartOutputPath));

  job.status = 'tiling';
  job.message = 'Tiling ENC → vector tiles… (this can take a while)';
  await run(
    cfg.tilerPath,
    ['--in', root, '--out', cfg.chartOutputPath, '-maxzoom', String(cfg.maxZoom)],
    job
  );

  // Cells that appeared (or were refreshed) in the output.
  const after = listCells(cfg.chartOutputPath);
  const added = after.filter((c) => !before.has(c));
  job.cells = added.length ? added : after; // fall back to all if names overlapped

  job.status = 'done';
  job.finishedAt = Date.now();
  job.message = added.length
    ? `Tiled ${added.length} cell(s): ${added.join(', ')}. Reload charts to see them.`
    : `Tiling complete. Reload charts to see them.`;

  // Best-effort cleanup of the extraction (keep the zip for reference is optional).
  try {
    fs.rmSync(encDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Directories under the chart output that hold a metadata.json (i.e. a tiled cell). */
function listCells(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          fs.existsSync(path.join(dir, d.name, 'metadata.json'))
      )
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Recursively locate the folder containing a CATALOG.031 file. */
function findEncRoot(dir: string, depth = 0): string | null {
  if (depth > 6) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile() && /^catalog\.031$/i.test(e.name))) {
    return dir;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findEncRoot(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract a .zip. Prefers the `unzip` binary; if it is not installed
 * (ENOENT) falls back to Python's built-in zipfile module (python3 is
 * near-universal on the host and needs no extra package).
 */
async function extractZip(zipPath: string, destDir: string, job: Job): Promise<void> {
  try {
    await run('unzip', ['-o', '-q', zipPath, '-d', destDir], job);
    return;
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = String((e as any)?.message ?? e);
    if (!/ENOENT|not found|cannot run/i.test(msg)) throw e; // real unzip failure
    pushLog(job, '(unzip not found — falling back to python3 zipfile)');
  }
  await run(
    'python3',
    [
      '-c',
      'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
      zipPath,
      destDir
    ],
    job
  );
}

/** Spawn a command, stream its output into the job log, resolve on exit 0. */
function run(cmd: string, args: string[], job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    pushLog(job, `$ ${cmd} ${args.join(' ')}`);
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reject(new Error(`Cannot run ${cmd}: ${(e as any)?.message ?? e}`));
      return;
    }
    const onData = (buf: Buffer) => {
      buf
        .toString()
        .split(/\r?\n/)
        .forEach((l) => pushLog(job, l));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(`${cmd} error: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}
