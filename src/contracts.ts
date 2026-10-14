import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const customType = "pi-taskflow-evaluation.link";
export const defaults = {
  maxSessionFiles: 2000,
  maxReadMiB: 512,
  maxFileMiB: 32,
  maxLineMiB: 2,
  maxRootRuns: 500,
  maxChildrenPerRoot: 100,
  maxExcerptKiB: 16,
  maxRecords: 20000,
  maxReportJsonMiB: 32,
  maxReportHtmlMiB: 48,
};
export type Limits = typeof defaults;
function isLimitKey(key: string): key is keyof Limits {
  return Object.hasOwn(defaults, key);
}
export function limitsSnapshot(settings: unknown): Limits {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("invalid_settings: taskflow-evaluation.limits");
  const namespace =
    "taskflow-evaluation" in settings
      ? settings["taskflow-evaluation"]
      : undefined;
  if (namespace === undefined) return { ...defaults };
  if (!namespace || typeof namespace !== "object" || Array.isArray(namespace))
    throw new Error("invalid_settings: taskflow-evaluation.limits");
  const overrides = "limits" in namespace ? namespace.limits : undefined;
  if (overrides === undefined) return { ...defaults };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("invalid_settings: taskflow-evaluation.limits");
  const limits = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (!isLimitKey(key))
      throw new Error("invalid_settings: unknown limits key");
    const multiplier = key.endsWith("MiB")
      ? 1048576
      : key.endsWith("KiB")
        ? 1024
        : 1;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      !Number.isSafeInteger(value * multiplier)
    )
      throw new Error(`invalid_settings: taskflow-evaluation.limits.${key}`);
    limits[key] = value;
  }
  return limits;
}

const github = Type.Object(
  {
    kind: Type.Literal("github"),
    host: Type.String(),
    owner: Type.String(),
    repo: Type.String(),
    number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
const local = Type.Object(
  { kind: Type.Literal("local"), path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const issueInput = Type.Union([Type.String({ minLength: 1 }), github, local]);
const refsInput = Type.Array(issueInput, { minItems: 1, maxItems: 100 });
export const parameters = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("begin_planning"),
      displayName: Type.String({ minLength: 1, maxLength: 160 }),
      sourceIssues: Type.Optional(refsInput),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("add_issues"), issues: refsInput },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("implementation"), issue: issueInput },
    { additionalProperties: false },
  ),
]);
export type Input = Static<typeof parameters>;
export type Issue = Static<typeof github> | Static<typeof local>;
const refs = Type.Array(Type.Union([github, local]), {
  minItems: 1,
  maxItems: 100,
});
const base = {
  version: Type.Literal(1),
  originSessionId: Type.String({ minLength: 1 }),
};
const planningBegin = {
  ...base,
  phase: Type.Literal("planning"),
  operation: Type.Literal("begin_planning"),
  displayName: Type.String({ minLength: 1, maxLength: 160 }),
  sourceIssues: Type.Optional(refs),
};
const taskflowId = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
// Read-only recognition of the original v1 shape; XOR and sourceIssues are checked below.
const legacyBeginSchema = Type.Object(
  {
    ...planningBegin,
    taskflowId: Type.Optional(taskflowId),
    unresolved: Type.Literal("source_issues_unresolved"),
  },
  { additionalProperties: false },
);
export const linkSchema = Type.Union([
  Type.Object(
    { ...planningBegin, taskflowId },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...base,
      phase: Type.Literal("planning"),
      operation: Type.Literal("add_issues"),
      issues: refs,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...base,
      phase: Type.Literal("implementation"),
      operation: Type.Literal("implementation"),
      issues: Type.Array(Type.Union([github, local]), {
        minItems: 1,
        maxItems: 1,
      }),
    },
    { additionalProperties: false },
  ),
]);
export type WritableLink = Static<typeof linkSchema>;
export type Link = WritableLink | Static<typeof legacyBeginSchema>;

export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
export function normalizeIssue(
  input: Static<typeof issueInput>,
  cwd: string,
): Issue {
  let ref: Issue;
  if (typeof input === "string" && /^https:/i.test(input)) {
    const url = new URL(input);
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(
      url.pathname,
    );
    if (
      !match ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw new Error("invalid_issue: https Issue URL required");
    ref = {
      kind: "github",
      host: url.hostname,
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
    };
  } else if (typeof input === "string") {
    ref = { kind: "local", path: input };
  } else ref = input;
  if (ref.kind === "github") {
    if (
      !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
        ref.host,
      ) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(ref.owner) ||
      ref.owner.includes("--") ||
      !/^[a-z0-9_.-]{1,100}$/i.test(ref.repo) ||
      [".", ".."].includes(ref.repo) ||
      !Number.isSafeInteger(ref.number) ||
      ref.number <= 0
    )
      throw new Error(
        "invalid_issue: host/owner/repo/positive number required",
      );
    return {
      kind: "github",
      host: ref.host.toLowerCase(),
      owner: ref.owner.toLowerCase(),
      repo: ref.repo.toLowerCase(),
      number: ref.number,
    };
  }
  if (
    isAbsolute(ref.path) ||
    ref.path.includes("\\") ||
    ref.path.includes("\0") ||
    ref.path.split("/").includes("..")
  )
    throw new Error("invalid_issue: project-relative ticket path required");
  const root = realpathSync(cwd);
  const target = resolve(root, ref.path);
  if (
    !contained(root, target) ||
    !contained(root, realpathSync(target)) ||
    !lstatSync(target).isFile()
  )
    throw new Error(
      "invalid_issue: local ticket containment/regular file required",
    );
  return { kind: "local", path: relative(root, target).split(sep).join("/") };
}
export function issueKey(issue: Issue): string {
  return JSON.stringify(issue);
}
export function unionIssues(issues: Issue[]): Issue[] {
  return [
    ...new Map(issues.map((issue) => [issueKey(issue), issue])).values(),
  ].toSorted((a, b) => issueKey(a).localeCompare(issueKey(b)));
}
export function validLink(data: unknown, cwd: string): data is Link {
  if (!Value.Check(linkSchema, data) && !Value.Check(legacyBeginSchema, data))
    return false;
  if (
    "unresolved" in data &&
    (data.taskflowId !== undefined || !data.sourceIssues)
  )
    return false;
  try {
    const issues =
      data.operation === "begin_planning"
        ? (data.sourceIssues ?? [])
        : data.issues;
    return issues.every(
      (issue) => issueKey(normalizeIssue(issue, cwd)) === issueKey(issue),
    );
  } catch {
    return false;
  }
}
