import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  candidateList,
  runConflict,
  type ReadBudget,
  type Scan,
} from "./discovery.js";
import {
  hash,
  retainObservation,
  redact,
  redactText,
  sourceKey,
  type Observation,
} from "./evidence.js";
import { issueKey, type Limits } from "./contracts.js";
import {
  parseReport,
  reportDigest,
  reportReferences,
  ReportError,
  proofLinks,
  pathExists,
  requireSafePath,
  safeRead,
  uuidPattern,
  type Report,
  type Root,
} from "./saved.js";

export interface CollectionResult {
  status: "updated" | "partial_success" | "not_updated";
  taskflowId: string;
  files: { json: string; html: string };
  contentDigest?: string;
  warnings: string[];
  errorCode?: string;
  key?: keyof Limits;
  value?: number;
  resume?: string;
  unreflected?: string;
  jsonCommitted: boolean;
  htmlUpdated: boolean;
}
const treeReasons = new Set([
  "derived_session",
  "recorded_tree_navigation",
  "invalid_entry_chain",
  "duplicate_session_id",
  "current_leaf_mismatch",
]);
function escape(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function html(report: Report): string {
  const issues = report.issues;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(report.displayName)}</title><style>body{max-width:75rem;margin:2rem auto;padding:0 1rem;font-family:system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}a:focus,summary:focus{outline:3px solid #369}section{border-top:1px solid #888;padding:1rem 0}</style></head><body><h1>Taskflow: ${escape(report.displayName)}</h1><p>品質・承認・完了の判定ではありません。取得範囲内の最新報告は実行終了を意味しません。</p><p>Collected: ${escape(report.collectedAt)} / ${escape(report.taskflowId)}</p><p>contentDigest: <code>${report.contentDigest}</code> — 最新 JSON との一致はこの HTML 単体では未確認。</p><nav aria-label="Report sections"><a href="#issues">Planning / Issues</a> · <a href="#roots">Root / child references</a> · <a href="#limits">取得不足・制限</a></nav><section id="issues"><h2>Planning / Issues</h2><h3>Planning</h3><ul>${report.planningSessionIds.map((sessionId) => `<li><a href="#root-${report.roots.findIndex((root) => root.sessionId === sessionId)}">${escape(sessionId)}</a></li>`).join("")}</ul><h3>Issues</h3><ul>${issues.map(({ issue, implementationSessionIds }, index) => `<li id="issue-${index}">${issue.kind === "github" ? `<a href="${escape(`https://${issue.host}/${issue.owner}/${issue.repo}/issues/${issue.number}`)}" rel="noreferrer">${escape(`${issue.owner}/${issue.repo}#${issue.number}`)}</a>` : escape(issue.path)}<ul>${implementationSessionIds.length ? implementationSessionIds.map((sessionId) => `<li><a href="#root-${report.roots.findIndex((root) => root.sessionId === sessionId)}">Implementation: ${escape(sessionId)}</a></li>`).join("") : "<li>実行記録が見つからない（未実施とは断定しない。quarantine の記録は通常集計から除外。）</li>"}</ul></li>`).join("")}</ul><p>実行記録が見つからない Issue は未実施とは断定しません。</p></section><section id="roots"><h2>Root / child references</h2><ul>${report.roots.map((root, index) => `<li><a href="#root-${index}">${escape(root.phase)}: ${escape(root.sessionId)}</a></li>`).join("")}</ul>${report.roots
    .map((root, index) => {
      const observations = report.observations.filter(
        (o) => o.provenance.sessionId === root.sessionId,
      );
      const quarantined = root.quarantine.length > 0;
      const rootLinks = proofLinks(observations);
      const issueLinks = report.issues
        .map(({ issue }, issueIndex) =>
          rootLinks.some(
            (link) =>
              link.operation === "implementation" &&
              issueKey(link.issues[0]) === issueKey(issue),
          )
            ? `<a href="#issue-${issueIndex}">${escape(issueKey(issue))}</a>`
            : "",
        )
        .filter(Boolean)
        .join(" · ");
      return `<section id="root-${index}"><h3>${escape(root.phase)} — ${escape(root.sessionId)}</h3><p>Issues: ${issueLinks || "Planning / explicit references"}</p><p>Source: ${escape(root.file)} / ${escape(root.availability)}</p><p>${quarantined ? `Quarantine: 通常の成果・Review・承認集計から除外 (${escape(root.quarantine.join(", "))})` : "Raw reports / Tool observations / unknown は区別します。Usage は出典 scope 別で、全体合計へ加算しません。"}</p><p>${escape(root.warnings.join("; "))}</p>${[
        "request",
        "report",
        "tool_call",
        "tool_result",
        "exit",
        "usage",
        "summary",
        "context_edit",
        "child_reference",
        "link",
      ]
        .map(
          (kind) =>
            `<h4>${escape(kind)}${kind === "report" ? " — 報告値（最新 ≠ 終了）" : kind === "child_reference" ? " — 参照のみ、本文未取得 W3" : ""}</h4>${observations
              .filter((o) => o.kind === kind)
              .map(
                (o) =>
                  `<details${quarantined ? "" : " open"}><summary>${escape(o.provenance.entryId)} / ${escape(o.provenance.field)}${o.key === root.latestReportKey ? " — 取得範囲内の最新報告" : ""}${o.shortened ? " — shortened" : ""}</summary><p>${escape(o.provenance.timestamp)} / acquired ${escape(o.provenance.collectedAt)}</p><pre>${escape(typeof o.value === "string" ? o.value : JSON.stringify(o.value, null, 2))}</pre></details>`,
              )
              .join("")}`,
        )
        .join("")}</section>`;
    })
    .join(
      "",
    )}</section><section id="limits"><h2>取得不足・制限・conflicts</h2><ul>${[...report.limitations, ...report.warnings, ...report.conflicts].map((item) => `<li>${escape(item)}</li>`).join("")}</ul><h3>Effective limits</h3><pre>${escape(JSON.stringify(report.effectiveLimits, null, 2))}</pre></section></body></html>\n`;
}
function limit(key: keyof Limits, actual: number, limits: Limits) {
  const maximum = limits[key] * (key.endsWith("MiB") ? 1048576 : 1);
  if (actual > maximum)
    throw new ReportError("report_merge_limit", key, limits[key]);
}
function merge(
  id: string,
  displayName: string,
  cwd: string,
  sessionDir: string,
  scan: Scan,
  live: Scan,
  old: Report | undefined,
  limits: Limits,
  candidate: ReturnType<typeof candidateList>["candidates"][number],
  membershipConflicts: ReturnType<typeof candidateList>["conflicts"],
): Report {
  const selected = new Set([
    ...(candidate?.planningSessionIds ?? []),
    ...(candidate?.implementationSessionIds ?? []),
  ]);
  const roots = new Map<string, Root>(
    (old?.roots ?? []).map((root) => [
      root.sessionId,
      { ...root, availability: "missing_or_unread", warnings: [] },
    ]),
  );
  const observations = new Map<string, Observation>();
  for (const observation of old?.observations ?? [])
    retainObservation(observations, observation);
  const current = new Map(live.runs.map((run) => [run.sessionId, run]));
  for (const run of scan.runs) {
    if (!selected.has(run.sessionId)) continue;
    const phase = run.links.find((link) => link.operation === "begin_planning")
      ? "planning"
      : "implementation";
    const previous = roots.get(run.sessionId);
    const source = current.get(run.sessionId);
    const quarantine = [
      ...new Set([
        ...(previous?.quarantine ?? []),
        ...run.warnings.filter((reason) => treeReasons.has(reason)),
        ...(live.quarantines ?? [])
          .filter((q) => q.sessionId === run.sessionId)
          .flatMap((q) => q.reasons),
      ]),
    ];
    roots.set(run.sessionId, {
      sessionId: run.sessionId,
      file: run.file,
      timestamp: run.timestamp,
      phase,
      quarantine,
      availability: source
        ? source.sourceBytes < (previous?.sourceBytes ?? 0)
          ? "shortened"
          : "available"
        : "missing_or_unread",
      sourceBytes: Math.max(
        previous?.sourceBytes ?? 0,
        source?.sourceBytes ?? run.sourceBytes,
      ),
      warnings: source?.warnings ?? [],
      latestReportKey: previous?.latestReportKey ?? null,
    });
    for (const o of run.observations) retainObservation(observations, o);
  }
  for (const root of roots.values()) {
    const source = current.get(root.sessionId);
    root.quarantine = [
      ...new Set([
        ...root.quarantine,
        ...(live.quarantines ?? [])
          .filter((q) => q.sessionId === root.sessionId)
          .flatMap((q) => q.reasons),
        ...(source?.warnings.filter((reason) => treeReasons.has(reason)) ?? []),
      ]),
    ];
    if (!selected.has(root.sessionId))
      root.quarantine = [
        ...new Set([...root.quarantine, "explicit_membership_not_unique"]),
      ];
    // Retain current evidence even when new immutable values invalidate former membership.
    if (source)
      for (const o of source.observations) retainObservation(observations, o);
    if (source) {
      root.availability =
        source.sourceBytes < root.sourceBytes ? "shortened" : "available";
      root.sourceBytes = Math.max(root.sourceBytes, source.sourceBytes);
    }
    root.warnings = source?.warnings ?? [
      "source_missing_or_unread; preserved evidence is not current availability",
    ];
    const mergedRun = scan.runs.find((run) => run.sessionId === root.sessionId);
    if (
      source &&
      mergedRun &&
      runConflict(mergedRun.links, mergedRun.observations)
    )
      root.quarantine = [
        ...new Set([...root.quarantine, "registration_conflict"]),
      ];
  }
  const conflicts = new Set(old?.conflicts ?? []);
  for (const conflict of membershipConflicts)
    if (conflict.taskflowIds.includes(id))
      conflicts.add(
        `explicit_issue_ownership_conflict:${issueKey(conflict.issue)}:taskflowIds=${JSON.stringify(conflict.taskflowIds)}`,
      );
  const values = new Map<string, Set<string>>();
  for (const observation of observations.values()) {
    const digests = values.get(observation.key) ?? new Set<string>();
    digests.add(observation.sourceDigest);
    values.set(observation.key, digests);
  }
  for (const [key, digests] of values)
    if (digests.size > 1) conflicts.add(`immutable_source_conflict:${key}`);
  for (const root of roots.values()) {
    const latest = current
      .get(root.sessionId)
      ?.observations.findLast((o) => o.kind === "report");
    root.latestReportKey = root.quarantine.length
      ? null
      : (latest?.key ?? root.latestReportKey);
  }
  limit("maxRootRuns", roots.size, limits);
  limit("maxRecords", observations.size, limits);
  const report: Report = {
    schemaVersion: 1,
    taskflowId: id,
    displayName,
    collectedAt: new Date().toISOString(),
    scope: { cwd: resolve(cwd), sessionDir: resolve(sessionDir) },
    effectiveLimits: limits,
    roots: [...roots.values()],
    observations: [...observations.values()],
    ...reportReferences([...roots.values()], [...observations.values()]),
    conflicts: [...conflicts],
    limitations: [
      "Uniqueness is limited to current cwd / Session directory and validated saved explicit evidence; outside-scope conflicts are unknown.",
      "Unrecorded tree navigation cannot be reconstructed.",
      "Latest report is not run completion; reports do not establish quality, approval or success.",
      "Missing records / Usage are unknown, not zero or not performed; scoped Usage is not a full total.",
      "Child references and public results in Root logs only; child files/bodies are not acquired (W3). Tool-specific details are raw JSON observations, not Evaluation judgments.",
      "Unknown secrets, power-loss durability and stale HTML viewed alone cannot be guaranteed.",
    ],
    warnings: live.warnings.map(
      (w) =>
        `${w.code}${w.file ? `:${w.file}` : ""}${w.key ? `:${w.key}=${w.value}; ${w.resume}` : ""}`,
    ),
    contentDigest: "",
  };
  if (
    old?.warnings.includes("known_secret_redaction_applied") ||
    live.runs.some((run) =>
      run.warnings.includes("known_secret_redaction_applied"),
    )
  )
    report.warnings.push("known_secret_redaction_applied");
  const redacted: Report = {
    ...report,
    displayName: redactText(report.displayName),
    scope: {
      cwd: redactText(report.scope.cwd),
      sessionDir: redactText(report.scope.sessionDir),
    },
    roots: report.roots.map((root) => ({
      ...root,
      file: redactText(root.file),
      warnings: root.warnings.map(redactText),
      quarantine: root.quarantine.map(redactText),
    })),
    warnings: report.warnings.map(redactText),
    limitations: report.limitations.map(redactText),
    conflicts: report.conflicts.map(redactText),
    observations: report.observations.map((o) => {
      const link = proofLinks([o])[0];
      const value = redact(link ?? o.value);
      const provenance = {
        ...o.provenance,
        sessionId: redactText(o.provenance.sessionId),
        entryId: redactText(o.provenance.entryId),
        field: redactText(o.provenance.field),
        file: redactText(o.provenance.file),
      };
      return {
        ...o,
        value,
        provenance,
        key: sourceKey(provenance),
        sourceDigest: o.shortened ? o.sourceDigest : hash(value),
      };
    }),
  };
  Object.assign(
    redacted,
    reportReferences(redacted.roots, redacted.observations),
  );
  if (JSON.stringify(redacted) !== JSON.stringify(report))
    redacted.warnings.push("known_secret_redaction_applied");
  redacted.contentDigest = reportDigest(redacted);
  parseReport(JSON.stringify(redacted), id, cwd, sessionDir);
  return redacted;
}
function prepareDirectory(cwd: string, id: string, warnings: string[]): string {
  requireSafePath(cwd);
  const base = join(resolve(cwd), ".pi", "taskflow-reports");
  const target = join(base, id);
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const repo = git(["rev-parse", "--is-inside-work-tree"]);
  if (repo.status === 0 && repo.stdout.trim() === "true") {
    const tracked = git(["ls-files", "--", ".pi/taskflow-reports"]);
    const ignored = [
      ".pi/taskflow-reports/",
      `.pi/taskflow-reports/${id}/report.json`,
      `.pi/taskflow-reports/${id}/report.html`,
    ].every(
      (path) =>
        git(["check-ignore", "--no-index", "--quiet", path]).status === 0,
    );
    if (tracked.status !== 0 || tracked.stdout.trim() || !ignored)
      throw new ReportError("report_git_not_private");
  } else if (repo.status !== 0 && /not a git repository/i.test(repo.stderr))
    warnings.push("non_git_directory; private reports have no VCS ignore gate");
  else throw new ReportError("report_git_check_failed");
  for (const path of [dirname(base), base, target]) {
    if (!pathExists(path)) mkdirSync(path, { mode: 0o700 });
    requireSafePath(path, path === dirname(base) ? undefined : 0o700);
    if (!lstatSync(path).isDirectory())
      throw new ReportError("unsafe_report_directory");
  }
  return target;
}
export function collectReport(
  id: string,
  displayName: string,
  cwd: string,
  sessionDir: string,
  scan: Scan,
  live: Scan,
  limits: Limits,
  budget: ReadBudget,
  candidate: ReturnType<typeof candidateList>["candidates"][number],
  membershipConflicts: ReturnType<typeof candidateList>["conflicts"],
): CollectionResult {
  cwd = realpathSync(cwd);
  sessionDir = realpathSync(sessionDir);
  const directory = join(resolve(cwd), ".pi", "taskflow-reports", id);
  const result: CollectionResult = {
    status: "not_updated",
    taskflowId: id,
    files: {
      json: join(directory, "report.json"),
      html: join(directory, "report.html"),
    },
    warnings: [],
    jsonCommitted: false,
    htmlUpdated: false,
  };
  let lock: number | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  const lockPath = join(directory, "report.lock");
  const temps: string[] = [];
  try {
    if (!uuidPattern.test(id)) throw new ReportError("invalid_taskflow_id");
    prepareDirectory(cwd, id, result.warnings);
    try {
      lock = openSync(lockPath, "wx", 0o600);
      lockIdentity = fstatSync(lock);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new ReportError("report_busy");
      throw error;
    }
    requireSafePath(lockPath, 0o600);
    let old: Report | undefined;
    if (pathExists(result.files.json))
      old = parseReport(
        safeRead(
          result.files.json,
          limits.maxReportJsonMiB * 1048576,
          "maxReportJsonMiB",
          limits,
          budget,
        ),
        id,
        cwd,
        sessionDir,
      );
    if (pathExists(result.files.html)) {
      const previousHtml = safeRead(
        result.files.html,
        limits.maxReportHtmlMiB * 1048576,
        "maxReportHtmlMiB",
        limits,
        budget,
      );
      if (
        !old ||
        !previousHtml.includes(
          `contentDigest: <code>${old.contentDigest}</code>`,
        )
      )
        result.warnings.push(
          "html_digest_mismatch; regenerated from canonical JSON",
        );
    } else if (old)
      result.warnings.push("html_unavailable; regenerated from canonical JSON");
    const report = merge(
      id,
      displayName,
      cwd,
      sessionDir,
      scan,
      live,
      old,
      limits,
      candidate,
      membershipConflicts,
    );
    report.warnings.push(...result.warnings);
    report.contentDigest = reportDigest(report);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const page = html(report);
    limit("maxReportJsonMiB", Buffer.byteLength(json), limits);
    limit("maxReportHtmlMiB", Buffer.byteLength(page), limits);
    for (const [path, content] of [
      [result.files.json, json],
      [result.files.html, page],
    ]) {
      const temp = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      temps.push(temp);
      try {
        requireSafePath(temp, 0o600);
        if (!fstatSync(fd).isFile())
          throw new ReportError("unsafe_report_file");
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
    }
    requireSafePath(directory, 0o700);
    for (const path of Object.values(result.files))
      if (pathExists(path)) {
        requireSafePath(path, 0o600);
        if (!lstatSync(path).isFile())
          throw new ReportError("unsafe_report_file");
      }
    renameSync(temps[0], result.files.json);
    result.jsonCommitted = true;
    result.contentDigest = report.contentDigest;
    result.warnings = report.warnings;
    try {
      renameSync(temps[1], result.files.html);
      result.htmlUpdated = true;
      result.status = "updated";
    } catch {
      result.status = "partial_success";
      result.errorCode = "html_update_failed";
      result.warnings.push("JSON committed; HTML stale or unavailable");
      result.resume =
        "Retry /taskflow-evaluate with the same target to repair HTML from canonical JSON; do not delete reports.";
    }
  } catch (error) {
    const e =
      error instanceof ReportError
        ? error
        : new ReportError("report_save_failed");
    result.errorCode = e.code;
    if (e.key) {
      result.key = e.key;
      result.value = e.value;
    }
    result.unreflected =
      "This operation's Root observations and output pair were not committed; old outputs preserved.";
    result.resume = e.key
      ? `Change taskflow-evaluation.limits.${e.key}, /reload, then retry; do not delete or thin preserved evidence.`
      : e.code === "report_busy"
        ? "Confirm no collection is running before manually removing report.lock, then retry; foreign/stale locks are never removed automatically."
        : "Correct path / permissions / Git ignore / schema; restore a valid backup or manually move the report directory to a private ignored location before retrying. Lost source evidence cannot be regenerated.";
  } finally {
    for (const temp of temps) {
      try {
        if (pathExists(temp)) unlinkSync(temp);
      } catch {
        result.warnings.push("own_temp_cleanup_failed");
      }
    }
    if (lock !== undefined) {
      closeSync(lock);
      try {
        const current = lstatSync(lockPath);
        if (
          current.dev === lockIdentity?.dev &&
          current.ino === lockIdentity.ino
        )
          unlinkSync(lockPath);
        else result.warnings.push("lock_identity_changed_not_removed");
      } catch {
        result.warnings.push("own_lock_cleanup_failed");
      }
    }
  }
  return result;
}
