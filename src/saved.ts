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
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  defaults,
  limitsSnapshot,
  issueKey,
  issueSchema,
  linkSchema,
  normalizeIssue,
  unionIssues,
  type Limits,
  type Link,
} from "./contracts.js";
import {
  cleanLink,
  retainObservation,
  hash,
  record,
  sourceKey,
  validJson,
  validUsage,
  type Observation,
} from "./evidence.js";
import type { ReadBudget, Run, Scan } from "./discovery.js";

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text = Type.String({ minLength: 1 });
const strings = Type.Array(text);
const provenanceSchema = Type.Object(
  {
    source: Type.Literal("session"),
    sessionId: text,
    entryId: text,
    field: text,
    file: text,
    timestamp: text,
    collectedAt: text,
  },
  { additionalProperties: false },
);
const observationSchema = Type.Object(
  {
    key: text,
    kind: Type.Union([
      Type.Literal("link"),
      Type.Literal("request"),
      Type.Literal("report"),
      Type.Literal("tool_call"),
      Type.Literal("tool_result"),
      Type.Literal("exit"),
      Type.Literal("usage"),
      Type.Literal("summary"),
      Type.Literal("context_edit"),
      Type.Literal("child_reference"),
    ]),
    provenance: provenanceSchema,
    value: Type.Unknown(),
    sourceDigest: text,
    shortened: Type.Boolean(),
  },
  { additionalProperties: false },
);
const rootSchema = Type.Object(
  {
    sessionId: text,
    file: text,
    timestamp: text,
    phase: Type.Union([
      Type.Literal("planning"),
      Type.Literal("implementation"),
    ]),
    quarantine: strings,
    availability: Type.Union([
      Type.Literal("available"),
      Type.Literal("missing_or_unread"),
      Type.Literal("shortened"),
    ]),
    sourceBytes: Type.Integer({ minimum: 0 }),
    warnings: strings,
    latestReportKey: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
const reportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskflowId: text,
    displayName: text,
    collectedAt: text,
    scope: Type.Object(
      { cwd: text, sessionDir: text },
      { additionalProperties: false },
    ),
    effectiveLimits: Type.Object(
      Object.fromEntries(
        Object.keys(defaults).map((key) => [key, Type.Integer({ minimum: 1 })]),
      ),
      { additionalProperties: false },
    ),
    roots: Type.Array(rootSchema),
    observations: Type.Array(observationSchema),
    planningSessionIds: strings,
    issues: Type.Array(
      Type.Object(
        { issue: issueSchema, implementationSessionIds: strings },
        { additionalProperties: false },
      ),
    ),
    conflicts: strings,
    limitations: strings,
    warnings: strings,
    contentDigest: text,
  },
  { additionalProperties: false },
);
export type Report = Static<typeof reportSchema>;
export type Root = Report["roots"][number];
export class ReportError extends Error {
  constructor(
    public code: string,
    public key?: keyof Limits,
    public value?: number,
  ) {
    super(code);
  }
}
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}
export function requireSafePath(path: string, privateMode?: number): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()))
      throw new ReportError("unsafe_report_path");
  }
  if (realpathSync(absolute) !== absolute)
    throw new ReportError("unsafe_report_path");
  if (
    privateMode !== undefined &&
    (lstatSync(absolute).mode & 0o777) !== privateMode
  )
    throw new ReportError("report_permissions");
}
export function safeRead(
  path: string,
  limit: number,
  key: keyof Limits,
  limits: Limits,
  budget: ReadBudget,
  privateFile = true,
): string {
  requireSafePath(path, privateFile ? 0o600 : undefined);
  const before = lstatSync(path);
  if (!before.isFile()) throw new ReportError("unsafe_report_file");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const start = fstatSync(fd);
    if (
      !start.isFile() ||
      start.ino !== before.ino ||
      start.dev !== before.dev ||
      (privateFile && (start.mode & 0o777) !== 0o600)
    )
      throw new ReportError("report_file_changed");
    if (start.size > limit)
      throw new ReportError("report_read_limit", key, limits[key]);
    if (start.size > limits.maxReadMiB * 1048576 - budget.bytes)
      throw new ReportError(
        "report_read_limit",
        "maxReadMiB",
        limits.maxReadMiB,
      );
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < start.size) {
      const chunk = Buffer.alloc(Math.min(65536, start.size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) throw new ReportError("report_file_changed");
      budget.bytes += count;
      offset += count;
      chunks.push(chunk.subarray(0, count));
    }
    const end = fstatSync(fd);
    const current = lstatSync(path);
    if (
      end.size !== start.size ||
      end.mtimeMs !== start.mtimeMs ||
      end.ctimeMs !== start.ctimeMs ||
      current.ino !== start.ino ||
      current.dev !== start.dev ||
      current.isSymbolicLink()
    )
      throw new ReportError("report_file_changed");
    requireSafePath(path, privateFile ? 0o600 : undefined);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    closeSync(fd);
  }
}
export function reportDigest(
  report: Omit<Report, "contentDigest"> | Report,
): string {
  return hash(
    Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== "contentDigest"),
    ),
  );
}
function validSavedLink(value: unknown, cwd: string): value is Link {
  if (!Value.Check(linkSchema, value)) return false;
  const refs =
    value.operation === "begin_planning"
      ? (value.sourceIssues ?? [])
      : value.issues;
  try {
    return refs.every((ref) =>
      ref.kind === "github"
        ? issueKey(normalizeIssue(ref, cwd)) === issueKey(ref)
        : !isAbsolute(ref.path) &&
          !ref.path.includes("\\") &&
          !ref.path.includes("\0") &&
          ref.path
            .split("/")
            .every((part) => !!part && part !== "." && part !== ".."),
    );
  } catch {
    return false;
  }
}
export function proofLinks(observations: Observation[]): Link[] {
  return observations.flatMap((o) =>
    o.kind === "link" && Value.Check(linkSchema, o.value) ? [o.value] : [],
  );
}
export function reportReferences(roots: Root[], observations: Observation[]) {
  const links = new Map(
    roots.map((root) => [
      root.sessionId,
      proofLinks(
        observations.filter((o) => o.provenance.sessionId === root.sessionId),
      ),
    ]),
  );
  const planningSessionIds = roots
    .filter((root) => root.phase === "planning")
    .map((root) => root.sessionId);
  const refs = unionIssues(
    planningSessionIds.flatMap((sessionId) =>
      links
        .get(sessionId)!
        .flatMap((link) =>
          link.operation === "begin_planning"
            ? (link.sourceIssues ?? [])
            : link.operation === "add_issues"
              ? link.issues
              : [],
        ),
    ),
  );
  const issues = refs.map((issue) => ({
    issue,
    implementationSessionIds: roots
      .filter(
        (root) =>
          root.phase === "implementation" &&
          root.quarantine.length === 0 &&
          links
            .get(root.sessionId)!
            .some(
              (link) =>
                link.operation === "implementation" &&
                issueKey(link.issues[0]) === issueKey(issue),
            ),
      )
      .map((root) => root.sessionId),
  }));
  return { planningSessionIds, issues };
}
function validObservation(observation: Observation): boolean {
  const field = observation.provenance.field;
  const value = observation.value;
  switch (observation.kind) {
    case "link":
      return field === "data";
    case "request":
      return (
        typeof value === "string" &&
        (field === "message.content" ||
          /^message\.content\.[0-9]+\.text$/.test(field))
      );
    case "report":
      return (
        typeof value === "string" &&
        /^message\.content\.[0-9]+\.text$/.test(field)
      );
    case "summary":
      return field === "summary" && typeof value === "string";
    case "exit":
      return (
        ["message.exitCode", "message.details.exitCode"].includes(field) &&
        Number.isSafeInteger(value)
      );
    case "usage":
      return (
        /^(?:message\.usage\.(?:root_assistant|tool_nested)|(?:compaction|branch_summary)\.usage|usage\..+)$/.test(
          field,
        ) && validUsage(value)
      );
    case "context_edit":
      return field === "targetId"
        ? typeof value === "string"
        : field === "replacement"
          ? value === null
          : (field === "replacement.content" ||
              /^replacement\.content\.[0-9]+\.text$/.test(field)) &&
            typeof value === "string";
    case "tool_call":
      return field === "message.command"
        ? typeof value === "string"
        : /^message\.content\.[0-9]+$/.test(field) &&
            record(value) &&
            typeof value.id === "string" &&
            typeof value.name === "string" &&
            record(value.arguments);
    case "tool_result":
      return field === "message.details"
        ? validJson(value)
        : /^message\.content\.[0-9]+\.text$/.test(field)
          ? typeof value === "string"
          : field === "message.tool"
            ? record(value) &&
              typeof value.toolName === "string" &&
              typeof value.toolCallId === "string" &&
              typeof value.isError === "boolean"
            : field === "message.output" &&
              record(value) &&
              typeof value.output === "string" &&
              typeof value.cancelled === "boolean" &&
              typeof value.truncated === "boolean";
    case "child_reference": {
      const key =
        /^message\.details\.(runId|asyncId|sessionId|sessionFile|outputPath)$/.exec(
          field,
        )?.[1];
      return (
        !!key &&
        record(value) &&
        typeof value.toolName === "string" &&
        ["subagent", "bg_wait"].includes(value.toolName) &&
        typeof value[key] === "string" &&
        value.acquisition === "reference_only_W3"
      );
    }
    default:
      return false;
  }
}
export function parseReport(
  input: string,
  taskflowId: string,
  cwd: string,
  sessionDir: string,
): Report {
  cwd = realpathSync(cwd);
  sessionDir = realpathSync(sessionDir);
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new ReportError("invalid_report_json");
  }
  if (
    !Value.Check(reportSchema, value) ||
    value.taskflowId !== taskflowId ||
    !uuidPattern.test(taskflowId) ||
    value.scope.cwd !== resolve(cwd) ||
    value.scope.sessionDir !== resolve(sessionDir) ||
    !Number.isFinite(Date.parse(value.collectedAt)) ||
    reportDigest(value) !== value.contentDigest
  )
    throw new ReportError("invalid_report_schema");
  try {
    limitsSnapshot({
      "taskflow-evaluation": { limits: value.effectiveLimits },
    });
  } catch {
    throw new ReportError("invalid_report_schema");
  }
  const roots = new Map(value.roots.map((root) => [root.sessionId, root]));
  if (roots.size !== value.roots.length)
    throw new ReportError("invalid_report_identity");
  const keys = new Set<string>();
  for (const root of value.roots) {
    if (
      !Number.isSafeInteger(root.sourceBytes) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(root.sessionId) ||
      dirname(root.file) !== resolve(sessionDir) ||
      !root.file.endsWith(".jsonl") ||
      !Number.isFinite(Date.parse(root.timestamp))
    )
      throw new ReportError("invalid_report_identity");
  }
  for (const observation of value.observations) {
    const p = observation.provenance;
    const root = roots.get(p.sessionId);
    const identity = `${observation.key}:${observation.sourceDigest}`;
    if (
      !root ||
      p.file !== root.file ||
      sourceKey(p) !== observation.key ||
      !Number.isFinite(Date.parse(p.timestamp)) ||
      !Number.isFinite(Date.parse(p.collectedAt)) ||
      !/^[0-9a-f]{64}$/.test(observation.sourceDigest) ||
      keys.has(identity)
    )
      throw new ReportError("invalid_report_provenance");
    keys.add(identity);
    if (!validObservation(observation))
      throw new ReportError("invalid_report_evidence");
    if (
      observation.kind === "link" &&
      (!validSavedLink(observation.value, cwd) ||
        observation.value.originSessionId !== p.sessionId ||
        p.field !== "data" ||
        observation.shortened ||
        hash(observation.value) !== observation.sourceDigest)
    )
      throw new ReportError("invalid_report_link_proof");
    if (
      observation.kind !== "link" &&
      !observation.shortened &&
      hash(observation.value) !== observation.sourceDigest
    )
      throw new ReportError("invalid_report_evidence");
    if (observation.kind === "usage" && !validUsage(observation.value))
      throw new ReportError("invalid_report_evidence");
    if (observation.kind === "exit" && !Number.isSafeInteger(observation.value))
      throw new ReportError("invalid_report_evidence");
    if (
      ["request", "report", "summary"].includes(observation.kind) &&
      typeof observation.value !== "string"
    )
      throw new ReportError("invalid_report_evidence");
    if (
      record(observation.value) &&
      (observation.value.role === "system" ||
        ["thinking", "image"].includes(String(observation.value.type)))
    )
      throw new ReportError("invalid_report_evidence");
  }
  for (const root of value.roots) {
    const links = proofLinks(
      value.observations.filter(
        (o) => o.provenance.sessionId === root.sessionId,
      ),
    );
    if (
      !links.length ||
      (links.some((link) => link.phase !== root.phase) &&
        !root.quarantine.includes("registration_conflict"))
    )
      throw new ReportError("invalid_report_link_proof");
    if (
      root.phase === "planning" &&
      !links.some(
        (link) =>
          link.operation === "begin_planning" && link.taskflowId === taskflowId,
      )
    )
      throw new ReportError("invalid_report_link_proof");
    if (
      root.latestReportKey !== null &&
      !value.observations.some(
        (o) =>
          o.key === root.latestReportKey &&
          o.kind === "report" &&
          o.provenance.sessionId === root.sessionId,
      )
    )
      throw new ReportError("invalid_report_evidence");
  }
  const references = reportReferences(value.roots, value.observations);
  if (
    hash(references) !==
    hash({ planningSessionIds: value.planningSessionIds, issues: value.issues })
  )
    throw new ReportError("invalid_report_references");
  return value;
}
export function savedReports(
  cwd: string,
  sessionDir: string,
  limits: Limits,
  budget: ReadBudget,
): {
  reports: Report[];
  errors: { taskflowId?: string; error: ReportError }[];
} {
  const result: {
    reports: Report[];
    errors: { taskflowId?: string; error: ReportError }[];
  } = { reports: [], errors: [] };
  const base = join(realpathSync(cwd), ".pi", "taskflow-reports");
  if (!pathExists(base)) return result;
  try {
    requireSafePath(base, 0o700);
    const dir = opendirSync(base);
    let count = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (!uuidPattern.test(entry.name)) continue;
        if (++count > limits.maxSessionFiles)
          throw new ReportError(
            "saved_candidate_limit",
            "maxSessionFiles",
            limits.maxSessionFiles,
          );
        const path = join(base, entry.name);
        try {
          requireSafePath(path, 0o700);
          const json = join(path, "report.json");
          if (pathExists(json))
            result.reports.push(
              parseReport(
                safeRead(
                  json,
                  limits.maxReportJsonMiB * 1048576,
                  "maxReportJsonMiB",
                  limits,
                  budget,
                ),
                entry.name,
                cwd,
                sessionDir,
              ),
            );
        } catch (error) {
          result.errors.push({
            taskflowId: entry.name,
            error:
              error instanceof ReportError
                ? error
                : new ReportError("report_read_failed"),
          });
        }
      }
    } finally {
      dir.closeSync();
    }
  } catch (error) {
    result.errors.push({
      error:
        error instanceof ReportError
          ? error
          : new ReportError("report_read_failed"),
    });
  }
  return result;
}
export function withSaved(scan: Scan, reports: Report[], failed = false): Scan {
  const runs = new Map<string, Run>();
  for (const report of reports)
    for (const root of report.roots) {
      const observations = report.observations.filter(
        (o) => o.provenance.sessionId === root.sessionId,
      );
      const links = proofLinks(observations);
      const previous = runs.get(root.sessionId);
      if (previous) {
        previous.links.push(...links);
        previous.observations.push(...observations);
      } else
        runs.set(root.sessionId, {
          sessionId: root.sessionId,
          file: root.file,
          timestamp: root.timestamp,
          links,
          warnings: root.quarantine,
          observations,
          entryIds: new Set(),
          lastEntryId: null,
          sourceBytes: root.sourceBytes,
        });
    }
  for (const run of scan.runs) {
    const old = runs.get(run.sessionId);
    runs.set(run.sessionId, {
      ...run,
      warnings: [
        ...(old?.warnings ?? []).filter(
          (reason) => !run.warnings.includes(reason),
        ),
        ...run.warnings,
      ],
      observations: [...(old?.observations ?? []), ...run.observations],
      links: [
        ...new Map(
          [...(old?.links ?? []), ...run.links].map((link) => [
            JSON.stringify(link),
            link,
          ]),
        ).values(),
      ],
    });
  }
  for (const run of runs.values()) {
    const retained = new Map<string, Observation>();
    for (const observation of run.observations)
      retainObservation(retained, observation);
    run.observations = [...retained.values()];
    run.links = [
      ...new Map(
        run.links.map((original) => {
          const link = cleanLink(original);
          return [JSON.stringify(link), link] as const;
        }),
      ).values(),
    ];
  }
  return {
    ...scan,
    savedTaskflows: reports.map((report) => ({
      taskflowId: report.taskflowId,
      displayName: report.displayName,
    })),
    runs: [...runs.values()],
    complete: scan.complete && !failed,
  };
}
