/**
 * The world layer: read-only workspace views (files.*, git.*) and the
 * deterministic command gate (world.run). Caps reject rather than truncate,
 * as the facade documents.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const GLOB_FILE_CAP = 2000;
export const GREP_MATCH_CAP = 2000;
export const GREP_BYTES_CAP = 256 * 1024;
export const READ_BYTES_CAP = 2 * 1024 * 1024;
export const DIFF_BYTES_CAP = 512 * 1024;
export const LOG_COMMIT_CAP = 100;
export const RUN_OUTPUT_CAP = 16 * 1024 * 1024;
export const FILE_ARTIFACT_BYTES_CAP = 20 * 1024 * 1024;
export const MARKDOWN_ARTIFACT_BYTES_CAP = 256 * 1024;

export class WorldCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldCapError";
  }
}

export function resolveInside(workspaceDir: string, relPath: string): string {
  const abs = path.resolve(workspaceDir, relPath);
  const root = path.resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new WorldCapError(`path "${relPath}" escapes the workspace`);
  }
  return abs;
}

/**
 * Symlink hardening on top of the lexical resolveInside check: refuse a
 * symlink final component outright, and verify the real location of the
 * deepest existing ancestor stays inside the workspace root. Without this,
 * a workspace-internal symlink pointing outside would pass the lexical
 * check and every follow-on stat/read/write would escape.
 */
export async function assertRealPathInside(workspaceDir: string, abs: string, relPath: string): Promise<void> {
  const root = path.resolve(workspaceDir);
  const inside = (p: string): boolean => p === root || p.startsWith(root + path.sep);
  const lst = await fs.lstat(abs).catch(() => null);
  if (lst?.isSymbolicLink()) {
    throw new WorldCapError(`path "${relPath}" is a symlink; refusing`);
  }
  let probe = abs;
  for (let i = 0; i < 64; i += 1) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real !== null) {
      if (!inside(real)) {
        throw new WorldCapError(`path "${relPath}" resolves outside the workspace through a symlink`);
      }
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return; // no existing ancestor above fs root
    probe = parent;
  }
}

/** Git refs and pathspecs go into argv directly: anything option-shaped is rejected. */
export function assertGitArg(value: string, what: string): void {
  if (value.startsWith("-")) {
    throw new WorldCapError(`git ${what} must be a ref or workspace path, not an option (got "${value}")`);
  }
}

/** Minimal glob: `*`, `**`, `?`, and `{a,b}` alternation, `/`-separated. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — any characters including separators; consume following `/` too
        i += 2;
        if (pattern[i] === "/") i += 1;
        re += "(?:.*)";
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      const body = end === -1 ? "" : pattern.slice(i + 1, end);
      re += `(?:${body.split(",").map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end === -1 ? i + 1 : end + 1;
    } else if ("\\^$.|+()[]".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set([".git", "node_modules", ".zcode-workflow"]);

async function walkFiles(dir: string, base: string, out: string[], depth: number): Promise<void> {
  if (out.length > GLOB_FILE_CAP * 2 || depth > 16) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await walkFiles(abs, base, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(rel);
    }
    if (out.length > GLOB_FILE_CAP * 2) return;
  }
}

export async function filesGlob(workspaceDir: string, pattern: string): Promise<string[]> {
  const re = globToRegExp(pattern);
  const all: string[] = [];
  await walkFiles(workspaceDir, workspaceDir, all, 0);
  const matches = all.filter((f) => re.test(f)).sort();
  if (matches.length > GLOB_FILE_CAP) {
    throw new WorldCapError(`glob "${pattern}" matched ${matches.length} files (cap ${GLOB_FILE_CAP}); narrow the pattern`);
  }
  return matches;
}

export async function filesRead(workspaceDir: string, relPath: string): Promise<string> {
  const abs = resolveInside(workspaceDir, relPath);
  const stat = await fs.stat(abs).catch(() => {
    throw new WorldCapError(`no such file: ${relPath}`);
  });
  if (!stat.isFile()) throw new WorldCapError(`not a file: ${relPath}`);
  await assertRealPathInside(workspaceDir, abs, relPath);
  if (stat.size > READ_BYTES_CAP) {
    throw new WorldCapError(`file ${relPath} is ${stat.size} bytes (cap ${READ_BYTES_CAP})`);
  }
  return fs.readFile(abs, "utf8");
}

export async function filesGrep(
  workspaceDir: string,
  pattern: string,
  glob?: string,
): Promise<{ path: string; line: number; text: string }[]> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "u");
  } catch (err) {
    throw new WorldCapError(`invalid grep pattern: ${(err as Error).message}`);
  }
  const candidates = glob ? await filesGlob(workspaceDir, glob) : (await walkAll(workspaceDir)).filter((f) => !f.startsWith(".openclaw/"));
  const matches: { path: string; line: number; text: string }[] = [];
  let bytes = 0;
  for (const file of candidates) {
    if (matches.length >= GREP_MATCH_CAP || bytes >= GREP_BYTES_CAP) {
      throw new WorldCapError(`grep overran its cap (${GREP_MATCH_CAP} matches / ${GREP_BYTES_CAP} bytes); narrow it with a glob`);
    }
    let content: string;
    try {
      const stat = await fs.stat(path.join(workspaceDir, file));
      if (!stat.isFile() || stat.size > READ_BYTES_CAP) continue;
      content = await fs.readFile(path.join(workspaceDir, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (re.test(line)) {
        matches.push({ path: file, line: i + 1, text: line.length > 500 ? line.slice(0, 500) + "…" : line });
        bytes += line.length;
        if (matches.length >= GREP_MATCH_CAP) break;
      }
    }
  }
  return matches;
}

async function walkAll(workspaceDir: string): Promise<string[]> {
  const out: string[] = [];
  await walkFiles(workspaceDir, workspaceDir, out, 0);
  return out.sort();
}

// ---- git (read-only views over the git CLI) ----

async function gitExec(workspaceDir: string, args: string[], bytesCap: number): Promise<string> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const overCap = (): void => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new WorldCapError(`git ${args[0]} output over ${bytesCap} bytes cap`));
      };
      child.stdout!.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (stdout.length > bytesCap) overCap();
      });
      child.stderr!.on("data", (d: Buffer) => {
        if (stderr.length < 65536) stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.slice(0, 400)}`));
        else resolve(stdout);
      });
    });
    return out;
  } catch (err) {
    if (err instanceof WorldCapError) throw err;
    throw new WorldCapError(`git failed: ${(err as Error).message}`);
  }
}

export async function gitStatus(workspaceDir: string) {
  const out = await gitExec(workspaceDir, ["status", "--porcelain=v1", "-b"], DIFF_BYTES_CAP);
  const lines = out.split("\n").filter(Boolean);
  let branch: string | undefined;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const m = /## (\S+?)(?:\.\.\.)?/.exec(line);
      if (m && !m[1]!.startsWith("HEAD")) branch = m[1];
      continue;
    }
    const x = line[0]!;
    const y = line[1]!;
    const file = line.slice(3).split(" -> ").pop()!.trim();
    if (x === "?") untracked.push(file);
    else {
      if (x !== " ") staged.push(file);
      if (y !== " ") unstaged.push(file);
    }
  }
  return { branch, clean: lines.filter((l) => !l.startsWith("##")).length === 0, staged, unstaged, untracked };
}

export async function gitChangedFiles(workspaceDir: string, base?: string): Promise<string[]> {
  if (base !== undefined) {
    if (base.includes("..")) throw new WorldCapError("a base names a single ref; no '..' ranges");
    assertGitArg(base, "base");
    const out = await gitExec(workspaceDir, ["diff", "--name-only", base], DIFF_BYTES_CAP);
    return out.split("\n").filter(Boolean).map((f) => f.trim());
  }
  const status = await gitStatus(workspaceDir);
  return [...new Set([...status.unstaged, ...status.untracked])].sort();
}

export async function gitDiff(workspaceDir: string, base?: string, relPath?: string): Promise<string> {
  if (base) assertGitArg(base, "base");
  if (relPath) assertGitArg(relPath, "path");
  const args = ["diff", ...(base ? [base] : ["HEAD"]), "--", ...(relPath ? [relPath] : [])];
  const out = await gitExec(workspaceDir, args, DIFF_BYTES_CAP);
  if (out.length > DIFF_BYTES_CAP) throw new WorldCapError(`diff over ${DIFF_BYTES_CAP} bytes`);
  return out;
}

export async function gitLog(workspaceDir: string, count = 20) {
  const n = Math.min(Math.max(1, count), LOG_COMMIT_CAP);
  const out = await gitExec(workspaceDir, ["log", `-n`, String(n), "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"], LOG_COMMIT_CAP * 256);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", subject = "", author = "", date = ""] = line.split("\x1f");
      return { hash, subject, author, date };
    });
}

// ---- world.run ----

export interface WorldRunOptions {
  timeoutMs?: number;
  output?: "full" | "discard" | { tail: number };
}

export async function worldRun(
  workspaceDir: string,
  cmd: string,
  args: string[],
  opts: WorldRunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const output = opts.output ?? "full";
  if (typeof output === "object" && (output.tail < 0 || output.tail > RUN_OUTPUT_CAP)) {
    throw new WorldCapError(`tail must be between 0 and ${RUN_OUTPUT_CAP}`);
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (err) {
      reject(new WorldCapError(`spawn failed: ${(err as Error).message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const tailKeep = typeof output === "object" ? output.tail : 0;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new WorldCapError(`command "${cmd}" timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const onChunk = (stream: "stdout" | "stderr") => (d: Buffer): void => {
      if (settled || output === "discard") return;
      let buf = (stream === "stdout" ? stdout : stderr) + d.toString("utf8");
      if (typeof output === "object") {
        // tail mode: keep only the requested tail (bulk-trim past a slack window so slicing is rare)
        if (buf.length > tailKeep + 65536) buf = buf.slice(-tailKeep);
      } else if (buf.length > RUN_OUTPUT_CAP) {
        // full mode: stop accumulating at the cap — kill the child instead of buffering past it
        child.kill("SIGKILL");
        finish(() =>
          reject(new WorldCapError(`output of "${cmd}" exceeded the ${RUN_OUTPUT_CAP}-byte cap; pass { output: "discard" } or { output: { tail: n } }`)),
        );
        return;
      }
      if (stream === "stdout") stdout = buf;
      else stderr = buf;
    };
    child.stdout!.on("data", onChunk("stdout"));
    child.stderr!.on("data", onChunk("stderr"));
    child.on("error", (err) => {
      finish(() => reject(new WorldCapError(`spawn failed: ${err.message}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        const shape = (text: string): string => {
          if (output === "discard") return "";
          if (typeof output === "object") return text.length > output.tail ? text.slice(text.length - output.tail) : text;
          return text;
        };
        resolve({ exitCode: code ?? 0, stdout: shape(stdout), stderr: shape(stderr) });
      });
    });
  });
}
