import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { collectEntry, type Observation } from "./evidence.js";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  contained,
  customType,
  issueKey,
  linkSchema,
  unionIssues,
  validLink,
  type Issue,
  type Limits,
  type Link,
} from "./contracts.js";

export interface Warning {
  code: string;
  file?: string;
  key?: keyof Limits;
  value?: number;
  resume: string;
}
export interface Run {
  sessionId: string;
  file: string;
  timestamp: string;
  links: Link[];
  warnings: string[];
  entryIds: Set<string>;
  observations: Observation[];
  lastEntryId: string | null;
  sourceBytes: number;
}
export interface Scan {
  runs: Run[];
  warnings: Warning[];
  complete: boolean;
  savedTaskflows?: { taskflowId: string; displayName: string }[];
  quarantines?: { sessionId: string; reasons: string[] }[];
}
export interface ReadBudget {
  bytes: number;
}
export const sessionEntryTypes = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "context_edit",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function warning(
  code: string,
  file?: string,
  key?: keyof Limits,
  limits?: Limits,
): Warning {
  return {
    code,
    file,
    ...(key && limits ? { key, value: limits[key] } : {}),
    resume: key
      ? `Change taskflow-evaluation.limits.${key}, /reload, then retry; unread scope is unresolved.`
      : "Correct the source or Session scope and retry; no source file was repaired.",
  };
}

// Only the initial byte boundary is read; later appends belong to the next operation.
export function readRun(
  file: string,
  sessionDir: string,
  cwd: string,
  limits: Limits,
  budget: ReadBudget,
): {
  run?: Run;
  warnings: Warning[];
  complete: boolean;
  quarantines?: { sessionId: string; reasons: string[] }[];
} {
  const warnings: Warning[] = [];
  const fail = (code: string, key?: keyof Limits) => {
    warnings.push(warning(code, file, key, limits));
  };
  let fd: number | undefined;
  let run: Run | undefined;
  const quarantines: { sessionId: string; reasons: string[] }[] = [];
  try {
    if (lstatSync(sessionDir).isSymbolicLink())
      throw new Error("unsafe_session_directory");
    const root = realpathSync(sessionDir);
    const path = resolve(file);
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !contained(root, realpathSync(path)) ||
      realpathSync(dirname(path)) !== root
    )
      throw new Error("unsafe_session_file");
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const start = fstatSync(fd);
    if (!start.isFile() || start.dev !== before.dev || start.ino !== before.ino)
      throw new Error("session_file_changed");
    if (start.size > limits.maxFileMiB * 1048576) {
      fail("file_limit", "maxFileMiB");
      return { warnings, complete: false };
    }
    if (start.size > limits.maxReadMiB * 1048576 - budget.bytes) {
      fail("read_limit", "maxReadMiB");
      return { warnings, complete: false };
    }
    const fingerprint = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let offset = 0;
    let first = true;
    let foreign = false;
    const ids = new Set<string>();
    let previous: string | null = null;
    const processLine = (line: Buffer) => {
      if (line.length > limits.maxLineMiB * 1048576)
        throw new Error("line_limit");
      let entry: unknown;
      try {
        entry = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(line),
        );
      } catch {
        throw new Error("invalid_json_line");
      }
      if (!record(entry)) throw new Error("invalid_session_schema");
      if (first) {
        first = false;
        if (
          entry.type !== "session" ||
          entry.version !== 3 ||
          !text(entry.id) ||
          !text(entry.cwd) ||
          !isAbsolute(entry.cwd) ||
          (entry.parentSession !== undefined &&
            typeof entry.parentSession !== "string") ||
          !text(entry.timestamp) ||
          !Number.isFinite(Date.parse(entry.timestamp)) ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(entry.id)
        )
          throw new Error("unsupported_session_header");
        if (resolve(entry.cwd) !== resolve(cwd)) {
          foreign = true;
          return;
        }
        run = {
          sessionId: entry.id,
          file,
          timestamp: entry.timestamp,
          links: [],
          observations: [],
          lastEntryId: null,
          sourceBytes: start.size,
          entryIds: ids,
          warnings:
            entry.parentSession === undefined ? [] : ["derived_session"],
        };
        return;
      }
      if (foreign) return;
      if (
        !sessionEntryTypes.has(String(entry.type)) ||
        !text(entry.id) ||
        !text(entry.timestamp) ||
        !Number.isFinite(Date.parse(entry.timestamp)) ||
        !(entry.parentId === null || text(entry.parentId))
      )
        throw new Error("invalid_session_schema");
      if (entry.type === "custom" && !text(entry.customType))
        throw new Error("invalid_session_schema");
      if (
        ids.has(entry.id) ||
        (entry.parentId !== null && !ids.has(entry.parentId))
      ) {
        if (run)
          quarantines.push({
            sessionId: run.sessionId,
            reasons: ["invalid_entry_chain"],
          });
        throw new Error("invalid_entry_chain");
      }
      if (entry.parentId !== previous || entry.type === "branch_summary")
        run?.warnings.push("recorded_tree_navigation");
      previous = entry.id;
      if (run) run.lastEntryId = entry.id;
      ids.add(entry.id);
      if (entry.type === "custom" && entry.customType === customType) {
        if (line.length > 65536 || !validLink(entry.data, cwd))
          throw new Error("unsupported_link_schema");
        if (entry.data.originSessionId === run?.sessionId)
          run.links.push(entry.data);
        else run?.warnings.push("fork_copy_ignored");
      }
      if (run)
        collectEntry(
          entry,
          run.sessionId,
          file,
          limits,
          run.observations,
          run.warnings,
        );
    };
    while (offset < start.size) {
      const size = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, start.size - offset),
        offset,
      );
      if (size === 0) throw new Error("session_file_shortened");
      offset += size;
      budget.bytes += size;
      fingerprint.update(buffer.subarray(0, size));
      const chunk = Buffer.concat([pending, buffer.subarray(0, size)]);
      let from = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) {
          processLine(chunk.subarray(from, i));
          from = i + 1;
        }
      }
      pending = Buffer.from(chunk.subarray(from));
      if (pending.length > limits.maxLineMiB * 1048576)
        throw new Error("line_limit");
      if (foreign) break;
    }
    if (!foreign && pending.length) fail("incomplete_tail");
    if (first) fail("missing_header");
    const end = fstatSync(fd);
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      realpathSync(dirname(path)) !== root ||
      !contained(root, realpathSync(path)) ||
      end.ino !== current.ino ||
      end.dev !== current.dev ||
      end.size < start.size ||
      (end.size === start.size &&
        (end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs))
    )
      throw new Error("session_file_changed");
    if (end.size > start.size) {
      if (offset > limits.maxReadMiB * 1048576 - budget.bytes) {
        fail("read_limit", "maxReadMiB");
        run = undefined;
      } else {
        const replay = createHash("sha256");
        let position = 0;
        while (position < offset) {
          const size = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, offset - position),
            position,
          );
          if (size === 0) throw new Error("session_file_shortened");
          position += size;
          budget.bytes += size;
          replay.update(buffer.subarray(0, size));
        }
        if (fingerprint.digest("hex") !== replay.digest("hex"))
          throw new Error("session_file_changed");
        const checked = fstatSync(fd);
        if (
          checked.size < end.size ||
          checked.mtimeMs !== end.mtimeMs ||
          checked.ctimeMs !== end.ctimeMs
        )
          throw new Error("session_file_changed");
        fail("appended_after_boundary");
      }
    }
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "session_read_failed";
    fail(code, code === "line_limit" ? "maxLineMiB" : undefined);
    run = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { run, warnings, complete: warnings.length === 0, quarantines };
}

export function discover(
  sessionDir: string,
  cwd: string,
  limits: Limits,
  budget: ReadBudget,
): Scan {
  const scan: Scan = {
    runs: [],
    warnings: [],
    complete: true,
    quarantines: [],
  };
  try {
    if (
      lstatSync(sessionDir).isSymbolicLink() ||
      !lstatSync(sessionDir).isDirectory()
    )
      throw new Error("unsafe_directory");
    const directory = opendirSync(realpathSync(sessionDir));
    let count = 0;
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        if (!entry.name.endsWith(".jsonl")) continue;
        if (++count > limits.maxSessionFiles) {
          scan.warnings.push(
            warning("candidate_limit", undefined, "maxSessionFiles", limits),
          );
          break;
        }
        const result = readRun(
          join(realpathSync(sessionDir), entry.name),
          sessionDir,
          cwd,
          limits,
          budget,
        );
        scan.warnings.push(...result.warnings);
        scan.quarantines!.push(...(result.quarantines ?? []));
        if (result.run) scan.runs.push(result.run);
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    scan.warnings.push(warning("session_directory_unavailable"));
  }
  const ids = new Set<string>();
  for (const run of scan.runs) {
    if (ids.has(run.sessionId)) {
      scan.warnings.push(warning("duplicate_session_id", basename(run.file)));
      scan.quarantines!.push({
        sessionId: run.sessionId,
        reasons: ["duplicate_session_id"],
      });
    }
    ids.add(run.sessionId);
    if (runConflict(run.links, run.observations))
      scan.warnings.push(warning("registration_conflict", run.file));
  }
  scan.complete = scan.warnings.length === 0;
  return scan;
}

export function runConflict(
  links: Link[],
  observations: Observation[] = [],
): boolean {
  const proofs = new Map<string, string>();
  for (const observation of observations)
    if (observation.kind === "link") {
      if (
        proofs.has(observation.key) &&
        proofs.get(observation.key) !== observation.sourceDigest
      )
        return true;
      proofs.set(observation.key, observation.sourceDigest);
    }
  if (new Set(links.map((link) => link.phase)).size > 1) return true;
  const beginnings = links.filter(
    (link) => link.operation === "begin_planning",
  );
  if (new Set(beginnings.map((link) => JSON.stringify(link))).size > 1)
    return true;
  if (
    links.some((link) => link.operation === "add_issues") &&
    beginnings.length === 0
  )
    return true;
  return (
    new Set(
      links
        .filter((link) => link.operation === "implementation")
        .map((link) => issueKey(link.issues[0])),
    ).size > 1
  );
}
export function membershipIndex(scan: Scan) {
  const issueTaskflows = new Map<
    string,
    { issue: Issue; taskflowIds: Set<string>; conflicted: boolean }
  >();
  for (const run of scan.runs) {
    const beginnings = run.links.filter(
      (link) => link.operation === "begin_planning",
    );
    const taskflowIds = new Set(
      beginnings.flatMap((link) => (link.taskflowId ? [link.taskflowId] : [])),
    );
    if (!taskflowIds.size) continue;
    const beginningConflict =
      new Set(run.links.map((link) => link.phase)).size > 1 ||
      new Set(beginnings.map((link) => JSON.stringify(link))).size > 1;
    const proofs = new Map<string, { digests: Set<string>; issues: Issue[] }>();
    for (const observation of run.observations) {
      if (
        observation.kind !== "link" ||
        !Value.Check(linkSchema, observation.value)
      )
        continue;
      const proof = proofs.get(observation.key) ?? {
        digests: new Set<string>(),
        issues: [],
      };
      proof.digests.add(observation.sourceDigest);
      if (observation.value.operation === "add_issues")
        proof.issues.push(...observation.value.issues);
      proofs.set(observation.key, proof);
    }
    const conflictingRefs = new Set(
      [...proofs.values()]
        .filter((proof) => proof.digests.size > 1)
        .flatMap((proof) => proof.issues.map(issueKey)),
    );
    const refs = [
      ...beginnings.flatMap((begin) =>
        begin.taskflowId ? (begin.sourceIssues ?? []) : [],
      ),
      ...run.links.flatMap((link) =>
        link.operation === "add_issues" ? link.issues : [],
      ),
    ];
    for (const issue of refs) {
      const key = issueKey(issue);
      const mapping = issueTaskflows.get(key) ?? {
        issue,
        taskflowIds: new Set<string>(),
        conflicted: false,
      };
      for (const taskflowId of taskflowIds) mapping.taskflowIds.add(taskflowId);
      mapping.conflicted ||= beginningConflict || conflictingRefs.has(key);
      issueTaskflows.set(key, mapping);
    }
  }
  const resolveKnown = (keys: string[]) => {
    let taskflowId: string | undefined;
    for (const key of keys) {
      const mapping = issueTaskflows.get(key);
      const ids = mapping?.taskflowIds;
      if (!ids || ids.size !== 1 || mapping?.conflicted) return undefined;
      const id = ids.values().next().value!;
      if (taskflowId && id !== taskflowId) return undefined;
      taskflowId = id;
    }
    return taskflowId;
  };
  return {
    issueTaskflows,
    resolve(issues: Issue[]): string | undefined {
      if (!scan.complete) return undefined;
      const keys = issues.map(issueKey);
      return resolveKnown(keys);
    },
  };
}
export function ownership(scan: Scan, issues: Issue[]): string | undefined {
  return membershipIndex(scan).resolve(issues);
}
export function candidateList(scan: Scan, membership = membershipIndex(scan)) {
  const candidates = new Map<
    string,
    {
      taskflowId: string;
      displayName: string;
      planningSessionIds: string[];
      planningTimestamps: string[];
      implementationSessionIds: string[];
      issues: Issue[];
      missingImplementationIssues: Issue[];
    }
  >();
  const unresolved: { sessionId: string; reason: string }[] = [];
  for (const run of scan.runs) {
    if (runConflict(run.links, run.observations)) {
      unresolved.push({
        sessionId: run.sessionId,
        reason: "registration_conflict",
      });
      continue;
    }
    const begin = run.links.find((link) => link.operation === "begin_planning");
    if (begin?.operation === "begin_planning") {
      if (!begin.taskflowId) {
        unresolved.push({
          sessionId: run.sessionId,
          reason: "source_issues_unresolved",
        });
        continue;
      }
      const candidate = candidates.get(begin.taskflowId) ?? {
        taskflowId: begin.taskflowId,
        displayName: begin.displayName,
        planningSessionIds: [],
        planningTimestamps: [],
        implementationSessionIds: [],
        issues: [],
        missingImplementationIssues: [],
      };
      candidate.planningSessionIds.push(run.sessionId);
      candidate.planningTimestamps.push(run.timestamp);
      candidate.issues = unionIssues([
        ...candidate.issues,
        ...(begin.sourceIssues ?? []),
        ...run.links.flatMap((link) =>
          link.operation === "add_issues" ? link.issues : [],
        ),
      ]);
      candidates.set(begin.taskflowId, candidate);
    } else if (run.links.length === 0)
      unresolved.push({
        sessionId: run.sessionId,
        reason: "registration_not_found",
      });
  }
  for (const saved of scan.savedTaskflows ?? [])
    if (!candidates.has(saved.taskflowId))
      candidates.set(saved.taskflowId, {
        ...saved,
        planningSessionIds: [],
        planningTimestamps: [],
        implementationSessionIds: [],
        issues: [],
        missingImplementationIssues: [],
      });
  const implementedIssues = new Set<string>();
  for (const run of scan.runs) {
    if (runConflict(run.links, run.observations)) continue;
    const implementation = run.links.find(
      (link) => link.operation === "implementation",
    );
    if (implementation?.operation !== "implementation") continue;
    const id = membership.resolve(implementation.issues);
    if (id && candidates.has(id)) {
      candidates.get(id)!.implementationSessionIds.push(run.sessionId);
      implementedIssues.add(issueKey(implementation.issues[0]));
    } else
      unresolved.push({
        sessionId: run.sessionId,
        reason: "issue_ownership_unresolved",
      });
  }
  for (const candidate of candidates.values()) {
    candidate.missingImplementationIssues = candidate.issues.filter(
      (issue) => !implementedIssues.has(issueKey(issue)),
    );
  }
  const conflicts = Array.from(membership.issueTaskflows.values())
    .filter((mapping) => mapping.taskflowIds.size > 1)
    .map((mapping) => ({
      issue: mapping.issue,
      taskflowIds: Array.from(mapping.taskflowIds),
    }));
  return { candidates: [...candidates.values()], unresolved, conflicts };
}
