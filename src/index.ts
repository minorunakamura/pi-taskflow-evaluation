import { randomUUID } from "node:crypto";
import { collectReport } from "./report.js";
import { savedReports, withSaved } from "./saved.js";
import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  customType,
  issueKey,
  limitsSnapshot,
  normalizeIssue,
  parameters,
  unionIssues,
  validLink,
  type Link,
  type WritableLink,
} from "./contracts.js";
import {
  candidateList,
  discover,
  ownership,
  membershipIndex,
  readRun,
  runConflict,
} from "./discovery.js";

function errorCode(error: unknown): string {
  // Never echo settings, arbitrary filesystem errors, or caller payloads.
  return error instanceof Error &&
    /^(invalid_settings|invalid_issue|invalid_input|session_|registration_|phase_|planning_|implementation_|entry_)/.test(
      error.message,
    )
    ? error.message
    : "operation_failed";
}
export default function taskflowEvaluation(pi: ExtensionAPI) {
  pi.registerTool({
    name: "taskflow_evaluation_link",
    label: "Taskflow Evaluation link",
    description:
      "Optionally record confirmed Planning/Issue references in the original Session. Never changes Taskflow approval or progress; reports saved only after checking the original file.",
    parameters,
    exposure: "direct",
    executionMode: "sequential",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const limits = limitsSnapshot(pi.getSettings());
        if (!Value.Check(parameters, params))
          throw new Error(
            "invalid_input: expected one of begin_planning/add_issues/implementation",
          );
        const input =
          params.operation === "begin_planning"
            ? {
                ...params,
                sourceIssues: params.sourceIssues
                  ? unionIssues(
                      params.sourceIssues.map((ref) =>
                        normalizeIssue(ref, ctx.cwd),
                      ),
                    )
                  : undefined,
              }
            : params.operation === "add_issues"
              ? {
                  ...params,
                  issues: unionIssues(
                    params.issues.map((ref) => normalizeIssue(ref, ctx.cwd)),
                  ),
                }
              : { ...params, issue: normalizeIssue(params.issue, ctx.cwd) };
        const manager = ctx.sessionManager;
        const originSessionId = manager.getSessionId();
        const file = manager.getSessionFile();
        if (!file) throw new Error("session_not_persistent");
        if (!existsSync(file))
          throw new Error(
            "session_not_saved: send a normal user message before retrying",
          );
        const budget = { bytes: 0 };
        const initial = readRun(
          file,
          manager.getSessionDir(),
          ctx.cwd,
          limits,
          budget,
        );
        if (
          !initial.complete ||
          !initial.run ||
          initial.run.sessionId !== originSessionId
        ) {
          const details = {
            status: "save_unconfirmed",
            errorCode: "session_source_unverified",
            warnings: initial.warnings,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
            isError: true,
          };
        }
        if (
          manager.getLeafId() !== null &&
          !initial.run.entryIds.has(manager.getLeafId()!)
        ) {
          const details = {
            status: "save_unconfirmed",
            errorCode: "session_pending_entries",
            resume:
              "Reload/resume the original Session through Pi and verify persistence before retrying; no repair or append was performed.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
            isError: true,
          };
        }
        const memoryLinks: Link[] = [];
        for (const entry of manager.getEntries()) {
          if (entry.type !== "custom" || entry.customType !== customType)
            continue;
          if (!validLink(entry.data, ctx.cwd))
            throw new Error(
              "registration_conflict: unsupported memory registration",
            );
          if (entry.data.originSessionId === originSessionId)
            memoryLinks.push(entry.data);
        }
        // Memory constrains retries and switches, but is never persistence evidence.
        const links = [
          ...new Map(
            [...initial.run.links, ...memoryLinks].map((link) => [
              JSON.stringify(link),
              link,
            ]),
          ).values(),
        ];
        if (runConflict(links)) throw new Error("registration_conflict");
        const phase =
          input.operation === "implementation" ? "implementation" : "planning";
        if (links.some((link) => link.phase !== phase))
          throw new Error("phase_switch_refused");
        const begin = links.find((link) => link.operation === "begin_planning");
        if (begin && "unresolved" in begin)
          throw new Error("planning_legacy_unresolved");
        let data: WritableLink;
        if (input.operation === "begin_planning") {
          if (begin?.operation === "begin_planning") {
            if (
              begin.displayName !== input.displayName ||
              JSON.stringify(begin.sourceIssues ?? []) !==
                JSON.stringify(input.sourceIssues ?? [])
            )
              throw new Error("planning_switch_refused");
            data = begin;
          } else {
            let taskflowId: string | undefined;
            if (input.sourceIssues) {
              const saved = savedReports(
                ctx.cwd,
                manager.getSessionDir(),
                limits,
                budget,
              );
              const scan = withSaved(
                discover(manager.getSessionDir(), ctx.cwd, limits, budget),
                saved.reports,
                saved.errors.length > 0,
              );
              taskflowId = ownership(scan, input.sourceIssues);
            } else taskflowId = randomUUID();
            if (!taskflowId)
              throw new Error("planning_source_issues_unresolved");
            data = {
              version: 1,
              originSessionId,
              phase: "planning",
              operation: "begin_planning",
              displayName: input.displayName,
              ...(input.sourceIssues
                ? { sourceIssues: input.sourceIssues }
                : {}),
              taskflowId,
            };
          }
        } else if (input.operation === "add_issues") {
          if (!begin) throw new Error("planning_not_registered");
          const savedIssues = initial.run.links.flatMap((link) =>
            link.operation === "add_issues" ? link.issues : [],
          );
          const additions = input.issues.filter(
            (issue) =>
              !savedIssues.some((saved) => issueKey(saved) === issueKey(issue)),
          );
          if (!additions.length) {
            const details = {
              status: "saved",
              phase,
              duplicate: true,
              ...(begin.operation === "begin_planning"
                ? { taskflowId: begin.taskflowId }
                : {}),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(details) }],
              details,
            };
          }
          if (
            !initial.run.links.some(
              (link) => link.operation === "begin_planning",
            )
          )
            throw new Error(
              "planning_save_unconfirmed: retry begin_planning first",
            );
          data = {
            version: 1,
            originSessionId,
            phase: "planning",
            operation: "add_issues",
            issues: additions,
          };
        } else {
          if (
            links.some(
              (link) =>
                link.operation === "implementation" &&
                issueKey(link.issues[0]) !== issueKey(input.issue),
            )
          )
            throw new Error("implementation_switch_refused");
          data = {
            version: 1,
            originSessionId,
            phase: "implementation",
            operation: "implementation",
            issues: [input.issue],
          };
        }
        const entry = {
          type: "custom",
          id: randomUUID(),
          parentId: manager.getLeafId(),
          timestamp: new Date().toISOString(),
          customType,
          data,
        };
        if (Buffer.byteLength(JSON.stringify(entry), "utf8") + 1 > 65536)
          throw new Error("entry_limit: 64 KiB");
        const duplicate = initial.run.links.some(
          (link) => JSON.stringify(link) === JSON.stringify(data),
        );
        let appendFailed = false;
        if (!duplicate) {
          try {
            pi.appendEntry(customType, data);
          } catch {
            appendFailed = true;
          }
        }
        const verified = duplicate
          ? initial
          : readRun(file, manager.getSessionDir(), ctx.cwd, limits, budget);
        const saved =
          verified.complete &&
          verified.run?.sessionId === originSessionId &&
          verified.run.links.some(
            (link) => JSON.stringify(link) === JSON.stringify(data),
          );
        const details = {
          ...data,
          status: saved ? "saved" : "save_unconfirmed",
          duplicate,
          ...(appendFailed
            ? { warning: "append_failed_original_file_checked" }
            : {}),
          warnings: verified.warnings,
          effectiveLimits: limits,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
          ...(!saved ? { isError: true } : {}),
        };
      } catch (error) {
        const details = { status: "rejected", errorCode: errorCode(error) };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
          isError: true,
        };
      }
    },
  });
  pi.registerCommand("taskflow-evaluate", {
    description:
      "Select a Taskflow and collect read-only Root evidence into private JSON/HTML reports; --list never writes reports.",
    async handler(args, ctx) {
      let receipt: object;
      try {
        const limits = limitsSnapshot(pi.getSettings());
        await ctx.waitForIdle();
        const budget = { bytes: 0 };
        const sessionDir = ctx.sessionManager.getSessionDir();
        const saved = savedReports(ctx.cwd, sessionDir, limits, budget);
        const live = discover(sessionDir, ctx.cwd, limits, budget);
        const current = live.runs.find(
          (run) => run.sessionId === ctx.sessionManager.getSessionId(),
        );
        if (current && current.lastEntryId !== ctx.sessionManager.getLeafId())
          current.warnings.push("current_leaf_mismatch");
        const scan = withSaved(live, saved.reports, saved.errors.length > 0);
        const membership = membershipIndex(scan);
        const listing = candidateList(scan, membership);
        const listReceipt = {
          ...listing,
          detectedQuarantine: live.quarantines ?? [],
          jsonCommitted: false,
          htmlUpdated: false,
          complete: scan.complete,
          warnings: [
            ...scan.warnings,
            ...saved.errors.map(({ taskflowId, error }) => ({
              code: error.code,
              taskflowId,
              key: error.key,
              value: error.value,
              resume: error.key
                ? `Change taskflow-evaluation.limits.${error.key}, /reload, then retry; saved evidence was not discarded.`
                : "Restore a valid private canonical report before retrying; no empty fallback.",
            })),
          ],
          effectiveLimits: limits,
          scope: { cwd: ctx.cwd, sessionDir },
        };
        if (args.trim() === "--list") {
          receipt = {
            ...listReceipt,
            status: "listed",
            sourceWarnings: scan.runs
              .filter((run) => run.warnings.length)
              .map((run) => ({
                sessionId: run.sessionId,
                warnings: run.warnings,
              })),
            effectiveLimits: limits,
            scope: {
              cwd: ctx.cwd,
              sessionDir: ctx.sessionManager.getSessionDir(),
            },
            limitations: [
              "Uniqueness is only within current cwd/top-level Session directory; outside-scope conflicts are unknown.",
              "Unrecorded tree navigation cannot be reconstructed.",
              "Child bodies (W3) and Taskflow Skill integration (W4) are not implemented.",
              "Missing Implementation records do not prove work was not performed.",
            ],
          };
        } else {
          const input = args.trim();
          let candidate: (typeof listing.candidates)[number] | undefined;
          let cancelled = false;
          let selectionError = "target_not_unique";
          if (
            !input &&
            ctx.hasUI &&
            scan.complete &&
            listing.candidates.length
          ) {
            const choices = listing.candidates.map(
              (item) =>
                `${item.displayName} | ${item.issues.map(issueKey).join(", ")} | ${item.planningTimestamps.join(", ")} | ${item.taskflowId}`,
            );
            const choice = await ctx.ui.select(
              "Taskflow を選択（取消は保存しません）",
              choices,
            );
            cancelled = choice === undefined;
            candidate = listing.candidates[choices.indexOf(choice ?? "")];
          } else if (input.startsWith("--taskflow "))
            candidate = listing.candidates.find(
              (item) => item.taskflowId === input.slice(11).trim(),
            );
          else if (input) {
            const issue = normalizeIssue(input, ctx.cwd);
            const id = membership.resolve([issue]);
            candidate = listing.candidates.find(
              (item) => item.taskflowId === id,
            );
          } else selectionError = "target_required";
          if (saved.errors.length) selectionError = saved.errors[0].error.code;
          else if (!scan.complete) selectionError = "discovery_incomplete";
          receipt = cancelled
            ? { ...listReceipt, status: "cancelled" }
            : candidate && scan.complete
              ? collectReport(
                  candidate.taskflowId,
                  candidate.displayName,
                  ctx.cwd,
                  sessionDir,
                  scan,
                  live,
                  limits,
                  budget,
                  candidate,
                  listing.conflicts,
                )
              : {
                  ...listReceipt,
                  status: "not_updated",
                  errorCode: selectionError,
                  resume:
                    "Select a unique explicit Issue or --taskflow UUID after correcting acquisition/schema limits; no report or pending state was created.",
                };
        }
      } catch (error) {
        receipt = {
          status: "not_updated",
          errorCode: errorCode(error),
          jsonCommitted: false,
          htmlUpdated: false,
        };
      }
      const text = `TASKFLOW_EVALUATION_RESULT ${JSON.stringify(receipt)}`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else {
        // Bypass Pi's instance write redirect without taking ownership of stdout.
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => process.stdout.removeListener("error", onError);
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          process.stdout.on("error", onError);
          try {
            (
              Writable.prototype.write as (
                chunk: string,
                callback: (error?: Error | null) => void,
              ) => boolean
            ).call(process.stdout, `${text}\n`, (error) => {
              if (error) {
                // Node emits error after the callback; keep our listener through that turn.
                setImmediate(cleanup);
                reject(error);
              } else {
                cleanup();
                resolve();
              }
            });
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      }
    },
  });
}
