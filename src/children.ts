import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { contained, customType, validLink, type Limits } from "./contracts.js";
import { sessionEntryTypes, type ReadBudget, type Run } from "./discovery.js";
import {
  collectEntry,
  observe,
  record,
  sourceKey,
  validChildUsage,
  validChildAccounting,
  validProcessTerminal,
  type Observation,
  type Provenance,
} from "./evidence.js";
import { safeRead, ReportError, type Child } from "./saved.js";

const idPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function id(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
const segment = (s: string) =>
  s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
function tempRoot(): string | undefined {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return resolve(configured);
  if (process.getuid)
    return join(realpathSync(tmpdir()), `pi-subagents-uid-${process.getuid()}`);
  let user = process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      /* No user scope from the platform. */
    }
  }
  if (user)
    return join(realpathSync(tmpdir()), `pi-subagents-user-${segment(user)}`);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return home
    ? join(realpathSync(tmpdir()), `pi-subagents-home-${segment(home)}`)
    : undefined;
}
export function childKey(
  child: Pick<Child, "rootSessionId" | "runId" | "index">,
): string {
  return JSON.stringify([child.rootSessionId, child.runId, child.index]);
}
export function mutableObservation(o: Observation): boolean {
  return (
    o.provenance.source === "artifact" &&
    ["status", "process-terminal"].includes(o.provenance.artifactKind ?? "")
  );
}
interface Reference {
  runId: string;
  wrapperRunId: string;
  index: number;
  resultPosition: number | undefined;
  agent: string;
  row: Record<string, unknown>;
  evidence: Record<string, unknown>;
  source: Observation;
  field: string;
}
// Paths are references, never permissions; only managed layouts are read.
function allowed(
  path: string,
  kind: string,
  ref: Reference,
  root: Run,
  cwd: string,
  sessionDir: string,
): boolean {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return false;
  const temp = tempRoot();
  if (kind === "session")
    return path.endsWith(".jsonl") && contained(root.file.slice(0, -6), path);
  if (["status", "process-terminal"].includes(kind))
    return (
      !!temp &&
      path ===
        join(temp, "async-subagent-runs", ref.wrapperRunId, `${kind}.json`)
    );
  if (["replay", "archive", "result"].includes(kind))
    return (
      !!temp &&
      path ===
        join(
          temp,
          "async-subagent-results",
          ...(kind === "result"
            ? []
            : [kind === "archive" ? "output-archives" : "completion-replay"]),
          `${ref.wrapperRunId}.json`,
        )
    );
  const artifactDirs = [
    join(sessionDir, "subagent-artifacts"),
    join(cwd, ".pi", "subagents", "artifacts"),
    ...(temp ? [join(temp, "artifacts")] : []),
  ];
  const agent = ref.agent.replace(/[^\w.-]/g, "_");
  const suffix = {
    metadata: "_meta.json",
    transcript: "_transcript.jsonl",
    output: "_output.md",
    input: "_input.md",
  }[kind];
  return (
    !!agent &&
    !!suffix &&
    artifactDirs.includes(dirname(path)) &&
    [
      `${ref.runId}_${agent}${suffix}`,
      `${ref.runId}_${agent}_${ref.index}${suffix}`,
    ].includes(basename(path))
  );
}
function references(root: Run): Reference[] {
  const refs: Reference[] = [];
  for (const source of root.observations) {
    if (
      source.provenance.rootSessionId ||
      source.kind !== "tool_result" ||
      !["message.details", "custom.details"].includes(
        source.provenance.field,
      ) ||
      !record(source.value)
    )
      continue;
    const details = source.value;
    const tool = root.observations.find(
      (o) =>
        o.provenance.entryId === source.provenance.entryId &&
        o.provenance.field === "message.tool",
    );
    if (
      source.provenance.field === "message.details" &&
      !(
        record(tool?.value) &&
        ["subagent", "bg_wait"].includes(String(tool.value.toolName))
      )
    )
      continue;
    const containers: { value: Record<string, unknown>; field: string }[] = [];
    if (id(details.runId) || id(details.asyncId))
      containers.push({ value: details, field: source.provenance.field });
    for (const key of ["completions", "runs"])
      if (Array.isArray(details[key]))
        details[key].forEach((item, i) => {
          if (record(item) && id(item.runId))
            containers.push({
              value: item,
              field: `${source.provenance.field}.${key}.${i}`,
            });
        });
    for (const { value, field } of containers) {
      const wrapperRunId = String(value.runId ?? value.asyncId);
      const rows =
        Array.isArray(value.results) && value.results.length
          ? value.results
          : Array.isArray(value.childRuns) && value.childRuns.length
            ? value.childRuns
            : [value];
      const rowField =
        rows === value.results
          ? "results"
          : rows === value.childRuns
            ? "childRuns"
            : undefined;
      rows.forEach((row, position) => {
        if (!record(row)) return;
        const index = row.index === undefined ? position : row.index;
        if (
          !Number.isSafeInteger(index) ||
          Number(index) < 0 ||
          (row.runId !== undefined && !id(row.runId))
        )
          return;
        refs.push({
          runId: id(row.runId) ? row.runId : wrapperRunId,
          wrapperRunId,
          index: Number(index),
          resultPosition: rowField === "results" ? position : undefined,
          agent:
            typeof row.agent === "string"
              ? row.agent
              : typeof value.agent === "string"
                ? value.agent
                : "",
          row: { ...value, ...row },
          evidence: row,
          source,
          field: rowField ? `${field}.${rowField}.${position}` : field,
        });
      });
    }
  }
  return refs;
}
export function collectChildren(
  roots: Run[],
  cwd: string,
  sessionDir: string,
  limits: Limits,
  budget: ReadBudget,
): { children: Child[]; observations: Observation[] } {
  const children: Child[] = [];
  const observations: Observation[] = [];
  for (const root of roots) {
    const unique = new Map<string, Reference[]>();
    for (const ref of references(root)) {
      const key = JSON.stringify([ref.runId, ref.index]);
      unique.set(key, [...(unique.get(key) ?? []), ref]);
    }
    let count = 0;
    for (const refs of unique.values()) {
      if (count++ >= limits.maxChildrenPerRoot) {
        root.warnings.push(
          `child_limit:maxChildrenPerRoot=${limits.maxChildrenPerRoot}; change taskflow-evaluation.limits.maxChildrenPerRoot, /reload, retry`,
        );
        break;
      }
      const ref = refs.at(-1)!;
      const child: Child = {
        rootSessionId: root.sessionId,
        runId: ref.runId,
        wrapperRunId: ref.wrapperRunId,
        index: ref.index,
        agent: ref.agent,
        sessionId: null,
        file: null,
        parentProof: "unconfirmed",
        availability: "missing_or_unread",
        sourceBytes: 0,
        warnings: [],
      };
      children.push(child);
      const add = (
        kind: Observation["kind"],
        field: string,
        value: unknown,
        artifactKind: string,
        file: string,
        timestamp = ref.source.provenance.timestamp,
        entryId = artifactKind === "public-result"
          ? ref.source.provenance.entryId
          : basename(file),
      ) => {
        const p: Provenance = {
          source: "artifact",
          sessionId: root.sessionId,
          rootSessionId: root.sessionId,
          runId: ref.runId,
          wrapperRunId: ref.wrapperRunId,
          index: ref.index,
          artifactKind,
          file: canonical(file),
          timestamp,
          collectedAt: new Date().toISOString(),
          entryId,
          field,
        };
        const o = observe(kind, value, p, limits, child.warnings);
        if (o) observations.push(o);
      };
      const fields = (
        row: Record<string, unknown>,
        artifactKind: string,
        file: string,
        prefix = "",
        source = ref.source,
      ) => {
        const fieldAdd = (
          kind: Observation["kind"],
          field: string,
          value: unknown,
        ) =>
          add(
            kind,
            field,
            value,
            artifactKind,
            file,
            source.provenance.timestamp,
            artifactKind === "public-result"
              ? source.provenance.entryId
              : basename(file),
          );
        for (const key of ["task", "finalOutput", "result"])
          if (row[key] !== undefined) {
            if (typeof row[key] === "string")
              fieldAdd(
                key === "task" ? "request" : "report",
                `${prefix}${key}`,
                row[key],
              );
            else
              child.warnings.push(
                `unsupported_child_evidence:${artifactKind}:${key}`,
              );
          }
        if (row.usage !== undefined) {
          if (validChildUsage(row.usage) && record(row.usage))
            fieldAdd(
              "usage",
              `${prefix}usage`,
              Object.fromEntries(
                [
                  "input",
                  "output",
                  "cacheRead",
                  "cacheWrite",
                  "cost",
                  "turns",
                ].map((k) => [
                  k,
                  row.usage && record(row.usage) ? row.usage[k] : undefined,
                ]),
              ),
            );
          else
            child.warnings.push(
              `unsupported_child_evidence:${artifactKind}:usage`,
            );
        }
        for (const key of ["totalTokens", "totalCost"])
          if (row[key] !== undefined) {
            if (validChildAccounting(row[key], key))
              fieldAdd("usage", `${prefix}${key}`, row[key]);
            else
              child.warnings.push(
                `unsupported_child_evidence:${artifactKind}:${key}`,
              );
          }
        for (const key of ["startedAt", "lastUpdate", "endedAt", "durationMs"])
          if (row[key] !== undefined) {
            if (
              typeof row[key] === "number" &&
              Number.isFinite(row[key]) &&
              row[key] >= 0
            )
              fieldAdd("lifecycle", `${prefix}${key}`, row[key]);
            else
              child.warnings.push(
                `unsupported_child_evidence:${artifactKind}:${key}`,
              );
          }
        if (row.exitCode !== undefined) {
          if (Number.isSafeInteger(row.exitCode))
            fieldAdd("exit", `${prefix}exitCode`, row.exitCode);
          else
            child.warnings.push(
              `unsupported_child_evidence:${artifactKind}:exitCode`,
            );
        }
        for (const key of [
          "state",
          "status",
          "success",
          "stopped",
          "interrupted",
          "timedOut",
          "outputPartial",
          "acceptance",
        ])
          if (row[key] !== undefined) {
            const valid = ["state", "status"].includes(key)
              ? typeof row[key] === "string"
              : key === "acceptance"
                ? record(row[key])
                : typeof row[key] === "boolean";
            if (valid) fieldAdd("lifecycle", `${prefix}${key}`, row[key]);
            else
              child.warnings.push(
                `unsupported_child_evidence:${artifactKind}:${key}`,
              );
          }
        if (row.children !== undefined || row.nested !== undefined)
          child.warnings.push("nested_children_not_acquired");
      };
      for (const r of refs)
        fields(r.evidence, "public-result", root.file, `${r.field}.`, r.source);
      function canonical(path: string): string {
        for (const [alias, canonicalRoot] of [
          [dirname(root.file), sessionDir],
          [tmpdir(), realpathSync(tmpdir())],
        ]) {
          if (contained(alias, path))
            return join(canonicalRoot, path.slice(alias.length));
        }
        return path;
      }
      const read = (path: unknown, kind: string): string | undefined => {
        if (typeof path !== "string") return undefined;
        if (
          !isAbsolute(path) ||
          path !== resolve(path) ||
          path.includes("\\") ||
          path.includes("\0")
        ) {
          child.warnings.push(`unsupported_child_path:${kind}:${path}`);
          return undefined;
        }
        const target = canonical(path);
        if (
          !allowed(
            target,
            kind,
            ref,
            { ...root, file: canonical(root.file) },
            cwd,
            sessionDir,
          )
        ) {
          child.warnings.push(`unsupported_child_path:${kind}:${path}`);
          return undefined;
        }
        try {
          return safeRead(
            target,
            limits.maxFileMiB * 1048576,
            "maxFileMiB",
            limits,
            budget,
            false,
            ["session", "transcript"].includes(kind)
              ? () => child.warnings.push("child_appended_after_boundary")
              : undefined,
          );
        } catch (error) {
          child.warnings.push(
            `child_artifact_unavailable:${kind}:${error instanceof Error ? error.message : "read_failed"}${error instanceof ReportError && error.key ? `:${error.key}=${error.value}; change taskflow-evaluation.limits.${error.key}, /reload, retry` : ""}`,
          );
          return undefined;
        }
      };
      const json = (
        path: unknown,
        kind: string,
      ): Record<string, unknown> | undefined => {
        const text = read(path, kind);
        if (text === undefined) return undefined;
        try {
          const value: unknown = JSON.parse(text);
          if (record(value)) return value;
        } catch {
          /* The artifact is reported, never repaired. */
        }
        child.warnings.push(`unsupported_child_schema:${kind}`);
        return undefined;
      };
      let temp = tempRoot();
      if (
        temp &&
        ((ref.row.asyncDir !== undefined &&
          (typeof ref.row.asyncDir !== "string" ||
            canonical(ref.row.asyncDir) !==
              join(temp, "async-subagent-runs", ref.wrapperRunId))) ||
          (ref.row.archivePath !== undefined &&
            (typeof ref.row.archivePath !== "string" ||
              !allowed(
                canonical(ref.row.archivePath),
                "archive",
                ref,
                root,
                cwd,
                sessionDir,
              ))))
      ) {
        child.warnings.push(
          "temp_scope_unconfirmed; current environment does not match the public reference",
        );
        temp = undefined;
      }
      let status: Record<string, unknown> | undefined;
      if (
        temp &&
        (ref.row.asyncDir !== undefined ||
          ref.row.asyncId !== undefined ||
          ref.row.mode !== undefined ||
          ref.source.provenance.field === "custom.details" ||
          ref.field.includes("completions"))
      ) {
        const statusPath = join(
          temp,
          "async-subagent-runs",
          ref.wrapperRunId,
          "status.json",
        );
        status = json(statusPath, "status");
        if (status) {
          if (
            status.lifecycleArtifactVersion !== 3 ||
            status.runId !== ref.wrapperRunId ||
            typeof status.sessionId !== "string" ||
            canonical(status.sessionId) !== root.file ||
            typeof status.cwd !== "string" ||
            !isAbsolute(status.cwd) ||
            realpathSync(status.cwd) !== cwd
          ) {
            child.warnings.push("invalid_child_status_identity");
            status = undefined;
          } else {
            fields(status, "status", statusPath);
            if (Array.isArray(status.steps)) {
              const step = status.steps[ref.index];
              if (
                record(step) &&
                (step.runId === undefined || step.runId === ref.runId) &&
                (step.agent === undefined ||
                  !ref.agent ||
                  step.agent === ref.agent)
              ) {
                if (!ref.agent && typeof step.agent === "string") {
                  ref.agent = step.agent;
                  child.agent = step.agent;
                }
                ref.row = { ...ref.row, ...step };
                fields(step, "status", statusPath, `steps.${ref.index}.`);
              }
            }
          }
        }
        const proofPath = join(
          temp,
          "async-subagent-runs",
          ref.wrapperRunId,
          "process-terminal.json",
        );
        const proof = json(proofPath, "process-terminal");
        if (proof) {
          if (proof.runId === ref.wrapperRunId && validProcessTerminal(proof))
            add(
              "lifecycle",
              "processTerminal",
              proof,
              "process-terminal",
              proofPath,
            );
          else child.warnings.push("invalid_process_terminal_identity");
        }
      }
      if (
        temp &&
        (status ||
          ref.row.archivePath !== undefined ||
          ref.field.includes("completions"))
      ) {
        let archivePosition =
          ref.field.includes("completions") ||
          ref.source.provenance.field === "custom.details"
            ? ref.resultPosition
            : undefined;
        const resultRowPosition = (rows: unknown[]): number | undefined => {
          const matches = rows.flatMap((row, position) => {
            if (
              !record(row) ||
              (row.index !== undefined && row.index !== ref.index) ||
              (row.runId !== undefined && row.runId !== ref.runId) ||
              (row.agent !== undefined && row.agent !== ref.agent)
            )
              return [];
            return row.index === ref.index ||
              (ref.runId !== ref.wrapperRunId && row.runId === ref.runId) ||
              (row.index === undefined &&
                ref.evidence.index === undefined &&
                position === ref.resultPosition)
              ? [position]
              : [];
          });
          return matches.length === 1 ? matches[0] : undefined;
        };
        const replayPath = join(
          temp,
          "async-subagent-results",
          "completion-replay",
          `${ref.wrapperRunId}.json`,
        );
        const replay = json(replayPath, "replay");
        if (replay) {
          if (
            replay.version !== 1 ||
            replay.runId !== ref.wrapperRunId ||
            typeof replay.sessionId !== "string" ||
            canonical(replay.sessionId) !== root.file ||
            typeof replay.expiresAt !== "number" ||
            typeof replay.completedAt !== "number" ||
            !record(replay.completion) ||
            replay.completion.runId !== ref.wrapperRunId
          )
            child.warnings.push("invalid_completion_replay_identity");
          else if (replay.expiresAt <= Date.now())
            child.warnings.push("completion_replay_expired");
          else {
            fields(replay.completion, "replay", replayPath, "completion.");
            if (Array.isArray(replay.completion.results))
              archivePosition = resultRowPosition(replay.completion.results);
            if (!ref.row.archivePath) ref.row.archivePath = replay.archivePath;
          }
        }
        const resultPath = join(
          temp,
          "async-subagent-results",
          `${ref.wrapperRunId}.json`,
        );
        const result = json(resultPath, "result");
        if (result) {
          if (
            (result.runId ?? result.id) !== ref.wrapperRunId ||
            result.version !== undefined ||
            (result.lifecycleArtifactVersion !== undefined &&
              result.lifecycleArtifactVersion !== 3) ||
            (result.sessionId !== undefined &&
              (typeof result.sessionId !== "string" ||
                canonical(result.sessionId) !== root.file))
          )
            child.warnings.push("invalid_child_result_identity");
          else {
            const position = Array.isArray(result.results)
              ? resultRowPosition(result.results)
              : undefined;
            const row = Array.isArray(result.results)
              ? position === undefined
                ? undefined
                : result.results[position]
              : result;
            if (
              record(row) &&
              (row.index === undefined || row.index === ref.index) &&
              (row.runId === undefined || row.runId === ref.runId) &&
              (row.agent === undefined || row.agent === ref.agent)
            ) {
              fields(
                row,
                "result",
                resultPath,
                position === undefined ? "" : `results.${position}.`,
              );
              ref.row = { ...ref.row, ...row };
            } else child.warnings.push("child_result_attribution_unknown");
            if (Array.isArray(result.results)) archivePosition = position;
          }
        }
        const archivePath =
          ref.row.archivePath ??
          join(
            temp,
            "async-subagent-results",
            "output-archives",
            `${ref.wrapperRunId}.json`,
          );
        const archive = json(archivePath, "archive");
        if (archive && typeof archivePath === "string") {
          if (
            archive.version !== 1 ||
            archive.runId !== ref.wrapperRunId ||
            typeof archive.createdAt !== "number" ||
            !Number.isFinite(new Date(archive.createdAt).getTime()) ||
            !Array.isArray(archive.entries)
          )
            child.warnings.push("invalid_output_archive_identity");
          else {
            const archiveTimestamp = new Date(archive.createdAt).toISOString();
            archive.entries.forEach((entry, position) => {
              if (
                !record(entry) ||
                (entry.agent !== undefined && entry.agent !== ref.agent)
              )
                return;
              // resultIndex is the producer's array position, not stable child index.
              if (
                entry.resultIndex !== undefined
                  ? archivePosition === undefined ||
                    entry.resultIndex !== archivePosition
                  : ref.resultPosition !== undefined ||
                    ref.field.includes(".childRuns.") ||
                    ref.runId !== ref.wrapperRunId
              ) {
                if (
                  entry.resultIndex === undefined ||
                  archivePosition === undefined
                )
                  child.warnings.push("archive_child_attribution_unknown");
                return;
              }
              if (
                entry.source === "result-tail" &&
                typeof entry.text === "string" &&
                (entry.truncated === undefined ||
                  typeof entry.truncated === "boolean")
              ) {
                add(
                  "report",
                  `entries.${position}.text`,
                  entry.text,
                  "archive",
                  archivePath,
                  archiveTimestamp,
                );
                if (entry.truncated)
                  child.warnings.push("archive_output_truncated");
              } else if (
                entry.source === "session" &&
                typeof entry.path === "string"
              )
                ref.row.sessionFile ??= entry.path;
              else if (
                entry.source === "output-artifact" &&
                typeof entry.path === "string"
              )
                ref.row.savedOutputPath ??= entry.path;
              else child.warnings.push("unsupported_output_archive_entry");
            });
          }
        }
      }
      const artifacts = record(ref.row.artifactPaths)
        ? ref.row.artifactPaths
        : {};
      let metadataPath = artifacts.metadataPath;
      if (!metadataPath && ref.agent)
        metadataPath = join(
          sessionDir,
          "subagent-artifacts",
          `${ref.runId}_${ref.agent.replace(/[^\w.-]/g, "_")}_meta.json`,
        );
      let metadata = json(metadataPath, "metadata");
      if (!metadata && artifacts.metadataPath === undefined && ref.agent) {
        metadataPath = join(
          sessionDir,
          "subagent-artifacts",
          `${ref.runId}_${ref.agent.replace(/[^\w.-]/g, "_")}_${ref.index}_meta.json`,
        );
        metadata = json(metadataPath, "metadata");
      }
      let invalidIdentity = child.warnings.includes(
        "unsupported_child_schema:metadata",
      );
      const metadataParent = metadata?.parentSessionId;
      if (metadata) {
        if (
          metadata.runId !== ref.runId ||
          metadata.agent !== ref.agent ||
          metadata.version !== undefined ||
          (metadata.parentSessionId !== undefined &&
            typeof metadata.parentSessionId !== "string")
        ) {
          invalidIdentity = true;
          child.warnings.push("invalid_child_metadata_identity");
        }
      }
      const sessionPath = ref.row.sessionFile;
      let header: Record<string, unknown> | undefined;
      let entries: Record<string, unknown>[] = [];
      const session = read(sessionPath, "session");
      if (session !== undefined) {
        try {
          const lines = session.split("\n");
          const last = lines.pop();
          if (last) child.warnings.push("child_session_unfinished_tail");
          if (lines.length) {
            const parseLine = (line: string): unknown => {
              if (Buffer.byteLength(line) > limits.maxLineMiB * 1048576)
                throw new Error("child_line_limit");
              return JSON.parse(line);
            };
            const h = parseLine(lines.shift() ?? "");
            if (
              !record(h) ||
              h.type !== "session" ||
              h.version !== 3 ||
              !id(h.id) ||
              typeof h.cwd !== "string" ||
              !isAbsolute(h.cwd) ||
              realpathSync(h.cwd) !== cwd ||
              typeof h.timestamp !== "string" ||
              !Number.isFinite(Date.parse(h.timestamp)) ||
              (h.parentSession !== undefined &&
                typeof h.parentSession !== "string")
            )
              throw new Error("unsupported_child_session_header");
            header = h;
            const ids = new Set<string>();
            let previous: string | null = null;
            for (const line of lines) {
              const entry = parseLine(line);
              if (
                !record(entry) ||
                !sessionEntryTypes.has(String(entry.type)) ||
                !id(entry.id) ||
                typeof entry.timestamp !== "string" ||
                !Number.isFinite(Date.parse(entry.timestamp)) ||
                !(entry.parentId === null || id(entry.parentId)) ||
                ids.has(entry.id) ||
                (entry.parentId !== null && !ids.has(entry.parentId))
              )
                throw new Error("invalid_child_entry_chain");
              if (
                entry.type === "custom" &&
                (typeof entry.customType !== "string" || !entry.customType)
              )
                throw new Error("invalid_child_session_schema");
              if (
                entry.type === "custom" &&
                entry.customType === customType &&
                (Buffer.byteLength(JSON.stringify(entry)) > 65536 ||
                  !validLink(entry.data, cwd))
              )
                throw new Error("unsupported_child_link_schema");
              if (
                entry.parentId !== previous ||
                entry.type === "branch_summary"
              )
                child.warnings.push("child_tree_navigation");
              ids.add(entry.id);
              previous = entry.id;
              entries.push(entry);
            }
            child.sessionId = h.id;
            child.file = canonical(String(sessionPath));
            child.sourceBytes = Buffer.byteLength(session);
            child.availability = "available";
            add(
              "child_reference",
              "header",
              {
                version: h.version,
                id: h.id,
                cwd: h.cwd,
                ...(h.parentSession === undefined
                  ? {}
                  : { parentSession: h.parentSession }),
              },
              "session-header",
              child.file,
              h.timestamp,
            );
          }
        } catch (error) {
          if (!(error instanceof Error && error.message === "child_line_limit"))
            invalidIdentity = true;
          entries = [];
          child.warnings.push(
            error instanceof Error
              ? error.message
              : "unsupported_child_session",
          );
        }
      }
      const headerParent =
        typeof header?.parentSession === "string" &&
        isAbsolute(header.parentSession) &&
        header.parentSession === resolve(header.parentSession)
          ? canonical(header.parentSession)
          : header?.parentSession;
      const conflict =
        (metadataParent !== undefined && metadataParent !== root.sessionId) ||
        (headerParent !== undefined && headerParent !== root.file);
      child.parentProof = conflict
        ? "conflict"
        : !invalidIdentity &&
            (metadataParent === root.sessionId || headerParent === root.file)
          ? "confirmed"
          : "unconfirmed";
      if (
        child.parentProof === "confirmed" &&
        !child.warnings.includes("child_tree_navigation")
      ) {
        const outputPath =
          artifacts.outputPath ??
          ref.row.savedOutputPath ??
          (typeof metadataPath === "string"
            ? metadataPath.replace(/_meta\.json$/, "_output.md")
            : undefined);
        const output = read(outputPath, "output");
        if (output !== undefined && typeof outputPath === "string")
          add("report", "text", output, "output", outputPath);
        if (child.availability !== "available") {
          if (ref.row.context === "fork")
            child.warnings.push("fork_child_attribution_unknown");
          else {
            const transcriptPath =
              artifacts.transcriptPath ?? metadata?.transcriptPath;
            const transcript = read(transcriptPath, "transcript");
            if (
              transcript !== undefined &&
              typeof transcriptPath === "string"
            ) {
              const lines = transcript.split("\n");
              if (lines.pop())
                child.warnings.push("child_transcript_unfinished_tail");
              const acquired: Observation[] = [];
              try {
                lines.forEach((line, position) => {
                  if (Buffer.byteLength(line) > limits.maxLineMiB * 1048576)
                    throw new Error("child_line_limit");
                  const row: unknown = JSON.parse(line);
                  if (
                    !record(row) ||
                    row.version !== 1 ||
                    row.runId !== ref.runId ||
                    row.agent !== ref.agent ||
                    row.childIndex !== ref.index ||
                    typeof row.cwd !== "string" ||
                    !isAbsolute(row.cwd) ||
                    realpathSync(row.cwd) !== cwd ||
                    typeof row.timestamp !== "string" ||
                    !Number.isFinite(Date.parse(row.timestamp))
                  )
                    throw new Error("invalid_child_transcript_identity");
                  if (row.recordType !== "message") return;
                  if (!record(row.message)) {
                    child.warnings.push(
                      `unsupported_child_evidence:transcript:line.${position}.message`,
                    );
                    return;
                  }
                  if (row.message.role === "system") return;
                  const message = {
                    ...row.message,
                    timestamp:
                      row.message.timestamp ?? Date.parse(row.timestamp),
                  };
                  const projected: Observation[] = [];
                  collectEntry(
                    {
                      type: "message",
                      id: `line-${position}`,
                      timestamp: row.timestamp,
                      message,
                    },
                    root.sessionId,
                    canonical(transcriptPath),
                    limits,
                    projected,
                    child.warnings,
                  );
                  for (const o of projected) {
                    o.provenance = {
                      ...o.provenance,
                      source: "artifact",
                      rootSessionId: root.sessionId,
                      runId: ref.runId,
                      index: ref.index,
                      wrapperRunId: ref.wrapperRunId,
                      artifactKind: "transcript",
                      field: `line.${position}.${o.provenance.field}`,
                    };
                    o.key = sourceKey(o.provenance);
                    acquired.push(o);
                  }
                  if (row.outputTruncated === true)
                    child.warnings.push("transcript_output_truncated");
                });
                observations.push(...acquired);
              } catch (error) {
                child.warnings.push(
                  error instanceof Error
                    ? error.message
                    : "unsupported_child_transcript",
                );
              }
            }
          }
        }
      }
      if (
        child.parentProof === "confirmed" &&
        !header &&
        metadata &&
        !child.warnings.includes("invalid_child_metadata_identity")
      )
        fields(metadata, "metadata", String(metadataPath));
      if (child.parentProof !== "confirmed")
        child.warnings.push(
          `child_parent_${child.parentProof}; public results only`,
        );
      else if (header && !child.warnings.includes("child_tree_navigation")) {
        if (
          metadata &&
          !child.warnings.includes("invalid_child_metadata_identity")
        )
          fields(metadata, "metadata", String(metadataPath));
        let inherited = false;
        let own = false;
        let uncertain = false;
        for (const entry of entries) {
          if (root.entryIds.has(String(entry.id))) {
            inherited = true;
            if (own) uncertain = true;
            const copied: Observation[] = [];
            collectEntry(entry, root.sessionId, root.file, limits, copied, []);
            if (
              copied.some(
                (copy) =>
                  !root.observations.some(
                    (original) =>
                      original.provenance.entryId === copy.provenance.entryId &&
                      original.provenance.field === copy.provenance.field &&
                      original.sourceDigest === copy.sourceDigest,
                  ),
              )
            )
              uncertain = true;
          } else own = true;
        }
        if (inherited) child.warnings.push("fork_inherited_prefix_excluded");
        if (uncertain || (ref.row.context === "fork" && !inherited))
          child.warnings.push("fork_child_attribution_unknown");
        else
          for (const entry of entries) {
            if (root.entryIds.has(String(entry.id)) || entry.type === "custom")
              continue;
            const acquired: Observation[] = [];
            collectEntry(
              entry,
              child.sessionId!,
              child.file!,
              limits,
              acquired,
              child.warnings,
            );
            for (const o of acquired) {
              o.provenance.field = o.provenance.field.replace(
                "root_assistant",
                "child_assistant",
              );
              o.provenance = {
                ...o.provenance,
                rootSessionId: root.sessionId,
                runId: ref.runId,
                index: ref.index,
              };
              o.key = sourceKey(o.provenance);
              if (
                o.kind === "child_reference" ||
                (o.kind === "tool_call" &&
                  record(o.value) &&
                  ["subagent", "bg_wait"].includes(String(o.value.name)))
              )
                child.warnings.push("nested_child_reference_not_acquired");
              observations.push(o);
            }
          }
      }
    }
  }
  return { children, observations };
}
