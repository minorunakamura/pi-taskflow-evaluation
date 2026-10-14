import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { customType, linkSchema, type Limits, type Link } from "./contracts.js";

export interface Provenance {
  source: "session" | "artifact";
  rootSessionId?: string;
  runId?: string;
  wrapperRunId?: string;
  index?: number;
  artifactKind?: string;
  sessionId: string;
  entryId: string;
  field: string;
  file: string;
  timestamp: string;
  collectedAt: string;
}
export interface Observation {
  key: string;
  kind:
    | "link"
    | "request"
    | "report"
    | "tool_call"
    | "tool_result"
    | "exit"
    | "usage"
    | "summary"
    | "context_edit"
    | "child_reference"
    | "lifecycle";
  provenance: Provenance;
  value: unknown;
  sourceDigest: string;
  shortened: boolean;
}
export function retainObservation(
  observations: Map<string, Observation>,
  observation: Observation,
): void {
  const identity = `${observation.key}:${observation.sourceDigest}`;
  const previous = observations.get(identity);
  if (
    !previous ||
    (previous.shortened && !observation.shortened) ||
    (previous.shortened === observation.shortened &&
      Buffer.byteLength(JSON.stringify(observation.value)) >
        Buffer.byteLength(JSON.stringify(previous.value)))
  )
    observations.set(identity, observation);
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function sourceKey(p: Provenance): string {
  return JSON.stringify(
    p.rootSessionId
      ? [
          p.source,
          p.rootSessionId,
          p.runId,
          p.index,
          p.sessionId,
          p.artifactKind,
          p.file,
          p.entryId,
          p.field,
        ]
      : [p.source, p.sessionId, p.entryId, p.field],
  );
}
export function redactText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(Authorization\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /\b((?:[\w-]*(?:token|password|passwd|secret|api[_-]?key))\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)/gi,
      "$1[REDACTED]",
    );
}
const forbidden =
  /^(?:thinking.*|system.*|sections|.*signature|image.*|base64.*)$/i;
const sensitive =
  /(?:authorization|password|passwd|secret|api[_-]?key|credential|token$)/i;
// Only JSON-safe values are retained; replay payloads are never evidence.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("redaction_failed");
  if (typeof value === "string") return redactText(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (record(value)) {
    if (
      ["thinking", "image", "system"].includes(String(value.type)) ||
      value.role === "system" ||
      (typeof value.mimeType === "string" &&
        value.mimeType.startsWith("image/"))
    )
      return "[OMITTED REPLAY PAYLOAD]";
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbidden.test(key))
        .map(([key, item]) => [
          redactText(key),
          sensitive.test(key) ? "[REDACTED]" : redact(item, depth + 1),
        ]),
    );
  }
  throw new Error("redaction_failed");
}
export function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => validJson(item, depth + 1));
  return (
    record(value) &&
    Object.values(value).every((item) => validJson(item, depth + 1))
  );
}
export function validUsage(value: unknown): boolean {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return (
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        value[key] >= 0,
    ) &&
    ["input", "output", "cacheRead", "cacheWrite", "total"].every(
      (key) =>
        typeof cost[key] === "number" &&
        Number.isFinite(cost[key]) &&
        cost[key] >= 0,
    ) &&
    ["cacheWrite1h", "reasoning"].every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "number" &&
          Number.isFinite(value[key]) &&
          value[key] >= 0),
    )
  );
}
export function validChildUsage(value: unknown): boolean {
  return (
    record(value) &&
    ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        value[key] >= 0,
    )
  );
}
export function validProcessTerminal(value: unknown): boolean {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.runnerProcessInstanceId !== "string" ||
    !value.runnerProcessInstanceId ||
    !["pending", "not-started", "observed", "unknown"].includes(
      String(value.state),
    )
  )
    return false;
  if (
    value.resumeDisposition !== undefined &&
    (typeof value.resumeDisposition !== "string" ||
      !["resumable", "non-resumable", "unavailable"].includes(
        value.resumeDisposition,
      ))
  )
    return false;
  if (value.state === "unknown" && typeof value.reason !== "string")
    return false;
  if (
    value.state === "observed" &&
    (typeof value.observedAt !== "number" ||
      !Number.isFinite(value.observedAt) ||
      !Array.isArray(value.instances))
  )
    return false;
  return (
    value.instances === undefined ||
    (Array.isArray(value.instances) &&
      value.instances.every(
        (instance) =>
          record(instance) &&
          ["runner", "pi-writer"].includes(String(instance.kind)) &&
          typeof instance.processInstanceId === "string" &&
          typeof instance.closeObservedAt === "number" &&
          Number.isFinite(instance.closeObservedAt) &&
          (instance.exitCode === null ||
            Number.isSafeInteger(instance.exitCode)) &&
          (instance.signal === null || typeof instance.signal === "string"),
      ))
  );
}
export function validChildAccounting(value: unknown, field: string): boolean {
  if (field.split(".").at(-1) === "totalCost")
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (field.split(".").at(-1) === "totalTokens")
    return (
      record(value) &&
      ["input", "output", "total"].every(
        (k) =>
          typeof value[k] === "number" &&
          Number.isFinite(value[k]) &&
          value[k] >= 0,
      ) &&
      ["window", "windowPeak"].every(
        (k) =>
          value[k] === undefined ||
          (typeof value[k] === "number" &&
            Number.isFinite(value[k]) &&
            value[k] >= 0),
      )
    );
  return field.split(".").at(-1) === "usage" && validChildUsage(value);
}
export function cleanLink(link: Link): Link {
  return link.operation === "begin_planning"
    ? { ...link, displayName: redactText(link.displayName) }
    : link;
}
export function observe(
  kind: Observation["kind"],
  input: unknown,
  provenance: Provenance,
  limits: Limits,
  warnings: string[],
): Observation | undefined {
  if (!validJson(input)) {
    warnings.push(
      `unsupported_evidence:${provenance.entryId}:${provenance.field}`,
    );
    return undefined;
  }
  const value =
    kind === "link" && Value.Check(linkSchema, input)
      ? cleanLink(input)
      : redact(input);
  if (JSON.stringify(value) !== JSON.stringify(input))
    warnings.push("known_secret_redaction_applied");
  const sourceDigest = hash(value);
  let shortened = false;
  const clip = (item: unknown): unknown => {
    if (typeof item === "string") {
      const bytes = Buffer.from(item);
      if (bytes.length <= limits.maxExcerptKiB * 1024) return item;
      shortened = true;
      let end = limits.maxExcerptKiB * 1024;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      return bytes.subarray(0, end).toString("utf8");
    }
    if (Array.isArray(item)) return item.map(clip);
    if (record(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [key, clip(nested)]),
      );
    return item;
  };
  return {
    key: sourceKey(provenance),
    kind,
    provenance,
    value: kind === "link" ? value : clip(value),
    sourceDigest,
    shortened,
  };
}
export function collectEntry(
  entry: Record<string, unknown>,
  sessionId: string,
  file: string,
  limits: Limits,
  observations: Observation[],
  warnings: string[],
) {
  const add = (kind: Observation["kind"], field: string, input: unknown) => {
    const observation = observe(
      kind,
      input,
      {
        source: "session",
        sessionId,
        entryId: String(entry.id),
        field,
        file,
        timestamp: String(entry.timestamp),
        collectedAt: new Date().toISOString(),
      },
      limits,
      warnings,
    );
    if (observation) observations.push(observation);
  };
  const addUsage = (value: unknown, field: string) => {
    if (validUsage(value) && record(value) && record(value.cost))
      add("usage", field, {
        ...Object.fromEntries(
          Object.entries(value).filter(([key]) =>
            [
              "input",
              "output",
              "cacheRead",
              "cacheWrite",
              "cacheWrite1h",
              "reasoning",
              "totalTokens",
            ].includes(key),
          ),
        ),
        cost: Object.fromEntries(
          Object.entries(value.cost).filter(([key]) =>
            ["input", "output", "cacheRead", "cacheWrite", "total"].includes(
              key,
            ),
          ),
        ),
      });
    else warnings.push(`unsupported_evidence:${String(entry.id)}:${field}`);
  };
  const texts = (
    content: unknown,
    kind: "request" | "report" | "tool_result" | "summary" | "context_edit",
    field: string,
    allowString: boolean,
  ) => {
    if (allowString && typeof content === "string") {
      add(kind, field, content);
      return;
    }
    if (!Array.isArray(content)) {
      warnings.push(`unsupported_evidence:${String(entry.id)}:${field}`);
      return;
    }
    content.forEach((block, index) => {
      if (!record(block)) {
        warnings.push(
          `unsupported_evidence:${String(entry.id)}:${field}.${index}`,
        );
        return;
      }
      if (block.type === "text" && typeof block.text === "string")
        add(kind, `${field}.${index}.text`, block.text);
      else if (["image", "thinking"].includes(String(block.type))) return;
      else if (
        kind === "report" &&
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        record(block.arguments) &&
        validJson(block.arguments)
      )
        add("tool_call", `${field}.${index}`, {
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        });
      else
        warnings.push(
          `unsupported_evidence:${String(entry.id)}:${field}.${index}`,
        );
    });
  };
  if (entry.type === "custom" && entry.customType === customType) {
    if (
      Value.Check(linkSchema, entry.data) &&
      entry.data.originSessionId === sessionId
    )
      add("link", "data", entry.data);
  } else if (
    entry.type === "custom_message" &&
    entry.customType === "subagent-notify"
  ) {
    texts(entry.content, "tool_result", "custom.content", true);
    if (record(entry.details) && Array.isArray(entry.details.runs))
      add("tool_result", "custom.details", entry.details);
    else
      warnings.push(`unsupported_evidence:${String(entry.id)}:custom.details`);
  } else if (entry.type === "message") {
    const message = entry.message;
    if (
      !record(message) ||
      typeof message.timestamp !== "number" ||
      !Number.isFinite(message.timestamp)
    ) {
      warnings.push(`unsupported_evidence:${String(entry.id)}:message`);
      return;
    }
    if (message.role === "system") return;
    if (message.role === "user")
      texts(message.content, "request", "message.content", true);
    else if (message.role === "assistant") {
      texts(message.content, "report", "message.content", false);
      if (message.usage !== undefined)
        addUsage(message.usage, "message.usage.root_assistant");
      else warnings.push(`usage_unknown:${String(entry.id)}:root_assistant`);
    } else if (message.role === "toolResult") {
      if (
        typeof message.toolName !== "string" ||
        typeof message.toolCallId !== "string" ||
        typeof message.isError !== "boolean"
      ) {
        warnings.push(`unsupported_evidence:${String(entry.id)}:tool_identity`);
        return;
      }
      add("tool_result", "message.tool", {
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
      });
      texts(message.content, "tool_result", "message.content", false);
      if (message.usage !== undefined)
        addUsage(message.usage, "message.usage.tool_nested");
      if (message.details !== undefined) {
        if (validJson(message.details))
          add("tool_result", "message.details", message.details);
        else
          warnings.push(
            `unsupported_evidence:${String(entry.id)}:message.details`,
          );
      }
      if (record(message.details)) {
        if (Number.isSafeInteger(message.details.exitCode))
          add("exit", "message.details.exitCode", message.details.exitCode);
        for (const key of [
          "runId",
          "asyncId",
          "sessionId",
          "sessionFile",
          "outputPath",
        ])
          if (
            ["subagent", "bg_wait"].includes(message.toolName) &&
            typeof message.details[key] === "string"
          )
            add("child_reference", `message.details.${key}`, {
              toolName: message.toolName,
              [key]: message.details[key],
              acquisition: "reference_only_W3",
            });
        warnings.push(
          `tool_details_raw_schema_not_interpreted:${String(entry.id)}`,
        );
      }
    } else if (message.role === "bashExecution") {
      if (
        typeof message.command !== "string" ||
        typeof message.output !== "string" ||
        typeof message.cancelled !== "boolean" ||
        typeof message.truncated !== "boolean"
      ) {
        warnings.push(`unsupported_evidence:${String(entry.id)}:bashExecution`);
        return;
      }
      add("tool_call", "message.command", message.command);
      add("tool_result", "message.output", {
        output: message.output,
        cancelled: message.cancelled,
        truncated: message.truncated,
      });
      if (Number.isSafeInteger(message.exitCode))
        add("exit", "message.exitCode", message.exitCode);
      else warnings.push(`exit_unknown:${String(entry.id)}`);
    } else warnings.push(`unsupported_evidence:${String(entry.id)}:role`);
  } else if (entry.type === "usage")
    addUsage(
      entry.usage,
      `usage.${typeof entry.kind === "string" ? redactText(entry.kind) : "unknown"}`,
    );
  else if (entry.type === "compaction" || entry.type === "branch_summary") {
    if (typeof entry.summary === "string")
      add("summary", "summary", entry.summary);
    else warnings.push(`unsupported_evidence:${String(entry.id)}:summary`);
    if (entry.usage !== undefined) addUsage(entry.usage, `${entry.type}.usage`);
  } else if (entry.type === "context_edit") {
    if (typeof entry.targetId === "string") {
      add("context_edit", "targetId", entry.targetId);
      if (entry.replacement === null) add("context_edit", "replacement", null);
      else if (record(entry.replacement))
        texts(
          entry.replacement.content,
          "context_edit",
          "replacement.content",
          true,
        );
      else
        warnings.push(
          `unsupported_evidence:${String(entry.id)}:replacement.content`,
        );
    } else
      warnings.push(`unsupported_evidence:${String(entry.id)}:context_edit`);
  }
}
