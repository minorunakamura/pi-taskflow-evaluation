import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, {
  appendFileSync,
  closeSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import {
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  ModelRuntime,
  type ExtensionAPI,
  ExtensionRunner,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import extension from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "taskflow-evaluation-"));
  temporaryDirectories.push(cwd);
  return { cwd, sessionDir: join(cwd, "sessions") };
}

async function registeredRuntime(
  manager: SessionManager,
  options: {
    settings?: () => Record<string, unknown>;
    append?: (type: string, data: unknown) => void;
  } = {},
) {
  const agentDir = join(workspace().cwd, "agent");
  mkdirSync(agentDir);
  const loader = new DefaultResourceLoader({
    cwd: manager.getCwd(),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.getSettings = options.settings ?? (() => ({}));
        pi.appendEntry =
          options.append ??
          ((type, data) => {
            manager.appendCustomEntry(type, data);
          });
        pi.sendUserMessage = () => {
          throw new Error("model turn forbidden");
        };
        pi.sendMessage = () => {
          throw new Error("model turn forbidden");
        };
        extension(pi);
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const method of [
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
  ] as const) {
    modelRuntime[method] = () => {
      throw new Error("model calls forbidden");
    };
  }
  return new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    manager.getCwd(),
    manager,
    new ModelRegistry(modelRuntime),
  );
}

function resultTaskflowId(details: unknown): string {
  if (
    typeof details !== "object" ||
    details === null ||
    !("taskflowId" in details) ||
    typeof details.taskflowId !== "string"
  )
    throw new Error("Expected taskflowId in tool result details");
  return details.taskflowId;
}

function runtime(
  manager: SessionManager,
  options: Parameters<typeof registeredRuntime>[1] = {},
) {
  const ready = registeredRuntime(manager, options);
  return {
    link: async (params: unknown) => {
      const runner = await ready;
      return (
        await runner
          .getToolDefinition("taskflow_evaluation_link")!
          .execute(
            "test",
            params,
            undefined,
            undefined,
            runner.createToolContext("test", undefined),
          )
      ).details;
    },
    list: async (args = "--list", waitForIdle = async () => {}) => {
      const runner = await ready;
      const lines: string[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original receiver below.
      const originalWrite = Writable.prototype.write;
      const output = vi
        .spyOn(Writable.prototype, "write")
        .mockImplementation(function (
          this: Writable,
          chunk,
          encodingOrCallback?:
            | BufferEncoding
            | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ) {
          if (
            this === process.stdout &&
            String(chunk).startsWith("TASKFLOW_EVALUATION_RESULT ")
          ) {
            lines.push(String(chunk));
            const done =
              typeof encodingOrCallback === "function"
                ? encodingOrCallback
                : callback;
            if (!done) throw new Error("receipt callback missing");
            done();
            return true;
          }
          return Reflect.apply(originalWrite, this, [
            chunk,
            encodingOrCallback,
            callback,
          ]);
        });
      try {
        const context = runner.createCommandContext();
        context.waitForIdle = waitForIdle;
        await runner.getCommand("taskflow-evaluate")!.handler(args, context);
        const line = lines.find((value) =>
          value.startsWith("TASKFLOW_EVALUATION_RESULT "),
        );
        return JSON.parse(line!.slice("TASKFLOW_EVALUATION_RESULT ".length));
      } finally {
        output.mockRestore();
      }
    },
  };
}

test("taskflow_evaluation_link saves and rediscovers an idempotent Planning notification", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "user",
    content: "Plan",
    timestamp: Date.now(),
  });
  const app = runtime(manager);
  const first = await app.link({
    operation: "begin_planning",
    displayName: "Issue delivery",
  });
  expect(first).toMatchObject({ status: "saved", phase: "planning" });
  const second = await app.link({
    operation: "begin_planning",
    displayName: "Issue delivery",
  });
  expect(second).toMatchObject({
    status: "saved",
    taskflowId: resultTaskflowId(first),
    duplicate: true,
  });
});

test("taskflow-evaluate --list discovers Planning Issues union and another Session Implementation without reports", async () => {
  const { cwd, sessionDir } = workspace();
  const planning = SessionManager.create(cwd, sessionDir);
  planning.appendMessage({
    role: "user",
    content: "Plan",
    timestamp: Date.now(),
  });
  const app = runtime(planning);
  const begin = await app.link({
    operation: "begin_planning",
    displayName: "Delivery",
  });
  const issue = "https://github.com/Example/Project/issues/1";
  expect(
    await app.link({ operation: "add_issues", issues: [issue] }),
  ).toMatchObject({ status: "saved" });
  expect(
    await app.link({
      operation: "add_issues",
      issues: [issue, "https://github.com/example/project/issues/2"],
    }),
  ).toMatchObject({ status: "saved" });
  const implementation = SessionManager.create(cwd, sessionDir);
  implementation.appendMessage({
    role: "user",
    content: "Implement",
    timestamp: Date.now(),
  });
  expect(
    await runtime(implementation).link({ operation: "implementation", issue }),
  ).toMatchObject({ status: "saved" });
  const list = await app.list();
  expect(list).toMatchObject({
    status: "listed",
    complete: true,
    jsonCommitted: false,
    htmlUpdated: false,
  });
  expect(list.candidates).toHaveLength(1);
  expect(list.candidates[0]).toMatchObject({
    taskflowId: resultTaskflowId(begin),
    displayName: "Delivery",
    planningSessionIds: [planning.getSessionId()],
    implementationSessionIds: [implementation.getSessionId()],
  });
  expect(list.candidates[0].issues).toHaveLength(2);
  expect(list.candidates[0].missingImplementationIssues).toEqual([
    {
      kind: "github",
      host: "github.com",
      owner: "example",
      repo: "project",
      number: 2,
    },
  ]);
});

test("taskflow-evaluate accepts public SDK custom Session IDs rather than only UUIDs", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = SessionManager.create(cwd, sessionDir, {
    id: "planning.run-1",
  });
  manager.appendMessage({
    role: "user",
    content: "Plan",
    timestamp: Date.now(),
  });
  const app = runtime(manager);
  expect(
    await app.link({ operation: "begin_planning", displayName: "Custom ID" }),
  ).toMatchObject({ status: "saved" });
  expect((await app.list()).candidates[0].planningSessionIds).toEqual([
    "planning.run-1",
  ]);
});

function savedSession(cwd: string, sessionDir: string) {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "user",
    content: "Recorded work",
    timestamp: Date.now(),
  });
  return manager;
}
const issue1 = "https://github.com/example/project/issues/1";
const issue2 = "https://github.com/example/project/issues/2";

test("taskflow_evaluation_link reuses only explicit same-Taskflow sourceIssues and leaves unknown notifications unsaved", async () => {
  const { cwd, sessionDir } = workspace();
  const first = runtime(savedSession(cwd, sessionDir));
  const original = await first.link({
    operation: "begin_planning",
    displayName: "First",
  });
  await first.link({ operation: "add_issues", issues: [issue1, issue2] });
  const replan = runtime(savedSession(cwd, sessionDir));
  expect(
    await replan.link({
      operation: "begin_planning",
      displayName: "Replan",
      sourceIssues: [issue2, issue1],
    }),
  ).toMatchObject({ status: "saved", taskflowId: resultTaskflowId(original) });
  const unknownSession = savedSession(cwd, sessionDir);
  const unknown = runtime(unknownSession);
  const diskBefore = readFileSync(unknownSession.getSessionFile()!);
  const memoryBefore = unknownSession.getEntries();
  const notification = {
    operation: "begin_planning",
    displayName: "Unknown",
    sourceIssues: ["https://github.com/example/project/issues/3"],
  };
  expect(await unknown.link(notification)).toEqual({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(readFileSync(unknownSession.getSessionFile()!)).toEqual(diskBefore);
  expect(unknownSession.getEntries()).toEqual(memoryBefore);
  await first.link({
    operation: "add_issues",
    issues: notification.sourceIssues,
  });
  expect(await unknown.link(notification)).toMatchObject({
    status: "saved",
    taskflowId: resultTaskflowId(original),
    duplicate: false,
  });
});

test("taskflow-evaluate lists currently acquired replan sourceIssues and missing Implementation after the original Planning log disappears", async () => {
  const { cwd, sessionDir } = workspace();
  const original = savedSession(cwd, sessionDir);
  const planning = runtime(original);
  const begin = await planning.link({
    operation: "begin_planning",
    displayName: "Original",
  });
  await planning.link({ operation: "add_issues", issues: [issue1, issue2] });
  const replan = savedSession(cwd, sessionDir);
  const app = runtime(replan);
  expect(
    await app.link({
      operation: "begin_planning",
      displayName: "Replan",
      sourceIssues: [issue1, issue2],
    }),
  ).toMatchObject({
    status: "saved",
    taskflowId: resultTaskflowId(begin),
  });
  const implementation = savedSession(cwd, sessionDir);
  await runtime(implementation).link({
    operation: "implementation",
    issue: issue1,
  });
  rmSync(original.getSessionFile()!);
  const before = readFileSync(replan.getSessionFile()!);
  const list = await app.list();
  expect(list.complete).toBe(true);
  expect(list.candidates).toHaveLength(1);
  expect(list.candidates[0]).toMatchObject({
    planningSessionIds: [replan.getSessionId()],
    implementationSessionIds: [implementation.getSessionId()],
  });
  expect(list.candidates[0].issues).toEqual([
    {
      kind: "github",
      host: "github.com",
      owner: "example",
      repo: "project",
      number: 1,
    },
    {
      kind: "github",
      host: "github.com",
      owner: "example",
      repo: "project",
      number: 2,
    },
  ]);
  expect(list.candidates[0].missingImplementationIssues).toEqual([
    {
      kind: "github",
      host: "github.com",
      owner: "example",
      repo: "project",
      number: 2,
    },
  ]);
  expect(readFileSync(replan.getSessionFile()!)).toEqual(before);
});

test("taskflow_evaluation_link refuses phase, Issue and Planning switches", async () => {
  const { cwd, sessionDir } = workspace();
  const planning = runtime(savedSession(cwd, sessionDir));
  await planning.link({ operation: "begin_planning", displayName: "Planning" });
  expect(
    await planning.link({ operation: "implementation", issue: issue1 }),
  ).toMatchObject({ status: "rejected", errorCode: "phase_switch_refused" });
  expect(
    await planning.link({ operation: "begin_planning", displayName: "Other" }),
  ).toMatchObject({ status: "rejected", errorCode: "planning_switch_refused" });
  const implementation = runtime(savedSession(cwd, sessionDir));
  await implementation.link({ operation: "implementation", issue: issue1 });
  expect(
    await implementation.link({ operation: "implementation", issue: issue1 }),
  ).toMatchObject({ status: "saved", duplicate: true });
  expect(
    await implementation.link({ operation: "implementation", issue: issue2 }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "implementation_switch_refused",
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "add_issues",
      issues: [issue1],
    }),
  ).toMatchObject({ status: "rejected", errorCode: "planning_not_registered" });
});

test("taskflow-evaluate ignores fork copies, cwd mismatch and nested Session files without modifying discovery sources", async () => {
  const { cwd, sessionDir } = workspace();
  const original = savedSession(cwd, sessionDir);
  const app = runtime(original);
  await app.link({ operation: "begin_planning", displayName: "Original" });
  await app.link({ operation: "add_issues", issues: [issue1] });
  const fork = SessionManager.forkFrom(
    original.getSessionFile()!,
    cwd,
    sessionDir,
  );
  const foreign = savedSession(join(cwd, "other-worktree"), sessionDir);
  await runtime(foreign).link({
    operation: "begin_planning",
    displayName: "Foreign",
  });
  const nested = savedSession(cwd, join(sessionDir, "nested"));
  await runtime(nested).link({
    operation: "begin_planning",
    displayName: "Nested",
  });
  const before = readFileSync(original.getSessionFile()!);
  const list = await app.list();
  expect(list.candidates).toHaveLength(1);
  expect(list.candidates[0].planningSessionIds).toEqual([
    original.getSessionId(),
  ]);
  expect(list.sourceWarnings).toContainEqual({
    sessionId: fork.getSessionId(),
    warnings: ["derived_session", "fork_copy_ignored", "fork_copy_ignored"],
  });
  expect(readFileSync(original.getSessionFile()!)).toEqual(before);
  expect(
    await runtime(fork).link({ operation: "implementation", issue: issue1 }),
  ).toMatchObject({ status: "saved" });
});

test("taskflow_evaluation_link refuses nonpersistent and pending Sessions without queuing a notification", async () => {
  const { cwd, sessionDir } = workspace();
  const pending = SessionManager.create(cwd, sessionDir);
  const request = { operation: "begin_planning", displayName: "Pending" };
  expect(
    await runtime(SessionManager.inMemory(cwd)).link(request),
  ).toMatchObject({ status: "rejected", errorCode: "session_not_persistent" });
  expect(await runtime(pending).link(request)).toMatchObject({
    status: "rejected",
    errorCode: "session_not_saved: send a normal user message before retrying",
  });
  pending.appendMessage({
    role: "user",
    content: "Now saved",
    timestamp: Date.now(),
  });
  expect((await runtime(pending).list()).candidates).toEqual([]);
});

test.each(["message", "custom"])(
  "taskflow_evaluation_link never appends after a memory-only %s leaf",
  async (kind) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const file = manager.getSessionFile()!;
    const disk = readFileSync(file);
    if (kind === "message")
      manager.appendMessage({
        role: "user",
        content: "Not persisted",
        timestamp: Date.now(),
      });
    else
      manager.appendCustomEntry("other-extension", { text: "Not persisted" });
    writeFileSync(file, disk);
    const memory = manager.getEntries();
    const app = runtime(manager, {
      append: () => {
        throw new Error("must not append");
      },
    });
    expect(
      await app.link({ operation: "begin_planning", displayName: "No repair" }),
    ).toMatchObject({
      status: "save_unconfirmed",
      errorCode: "session_pending_entries",
    });
    expect(manager.getEntries()).toEqual(memory);
    expect(readFileSync(file)).toEqual(disk);
    expect((await app.list()).candidates).toEqual([]);
  },
);

test("taskflow_evaluation_link checks original persistence after append failure and blocks a memory-only retry without corrupting the source", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  let proposal: unknown;
  const failing = runtime(manager, {
    append: (type, data) => {
      proposal = data;
      const disk = readFileSync(manager.getSessionFile()!);
      manager.appendCustomEntry(type, data);
      writeFileSync(manager.getSessionFile()!, disk);
      throw new Error("injected append failure");
    },
  });
  const request = { operation: "begin_planning", displayName: "Retry" };
  const failed = await failing.link(request);
  expect(failed).toMatchObject({ status: "save_unconfirmed" });
  const app = runtime(manager);
  const beforeRetry = readFileSync(manager.getSessionFile()!);
  expect(await app.link(request)).toMatchObject({
    status: "save_unconfirmed",
    errorCode: "session_pending_entries",
  });
  expect(readFileSync(manager.getSessionFile()!)).toEqual(beforeRetry);
  expect(proposal).toMatchObject({ taskflowId: resultTaskflowId(failed) });
  const other = savedSession(cwd, sessionDir);
  const partial = runtime(other, {
    append: (type, data) => {
      other.appendCustomEntry(type, data);
      throw new Error("saved then throw");
    },
  });
  expect(await partial.link(request)).toMatchObject({
    status: "saved",
    warning: "append_failed_original_file_checked",
  });
  expect(await partial.link(request)).toMatchObject({
    status: "saved",
    duplicate: true,
  });
});

test("taskflow_evaluation_link normalizes confirmed local tickets and rejects traversal and symlink escapes", async () => {
  const { cwd, sessionDir } = workspace();
  const outside = workspace().cwd;
  mkdirSync(join(cwd, "tickets"));
  writeFileSync(join(cwd, "tickets", "1.md"), "confirmed ticket");
  writeFileSync(join(outside, "secret.md"), "do not read");
  symlinkSync(outside, join(cwd, "escape"));
  const app = runtime(savedSession(cwd, sessionDir));
  expect(
    await app.link({ operation: "implementation", issue: "./tickets/1.md" }),
  ).toMatchObject({
    status: "saved",
    issues: [{ kind: "local", path: "tickets/1.md" }],
  });
  await Promise.all(
    [
      "../secret.md",
      "tickets/../tickets/1.md",
      join(cwd, "tickets/1.md"),
      "escape/secret.md",
    ].map(async (issue) => {
      expect(
        await runtime(savedSession(cwd, sessionDir)).link({
          operation: "implementation",
          issue,
        }),
      ).toMatchObject({ status: "rejected" });
    }),
  );
});

test.each([
  "1",
  "http://github.com/example/project/issues/1",
  "https://user:secret@github.com/example/project/issues/1",
  "https://github.com/example/project/issues/0",
  "https://github.com/example/project/issues/1?token=secret",
  {
    kind: "github",
    host: "bad/host",
    owner: "example",
    repo: "project",
    number: 1,
  },
  {
    kind: "github",
    host: "github.com",
    owner: "bad--owner",
    repo: "project",
    number: 1,
  },
  {
    kind: "github",
    host: "github.com",
    owner: "example",
    repo: "project",
    number: 1.5,
  },
])(
  "taskflow_evaluation_link rejects invalid Issue reference %j",
  async (issue) => {
    const { cwd, sessionDir } = workspace();
    expect(
      await runtime(savedSession(cwd, sessionDir)).link({
        operation: "implementation",
        issue,
      }),
    ).toMatchObject({ status: "rejected" });
  },
);

test("taskflow_evaluation_link enforces fixed displayName, refs and entry byte limits", async () => {
  const { cwd, sessionDir } = workspace();
  const app = runtime(savedSession(cwd, sessionDir));
  expect(
    await app.link({
      operation: "begin_planning",
      displayName: "x".repeat(161),
    }),
  ).toMatchObject({ status: "rejected" });
  expect(
    await app.link({
      operation: "begin_planning",
      displayName: "x".repeat(160),
    }),
  ).toMatchObject({ status: "saved" });
  expect(
    await app.link({
      operation: "add_issues",
      issues: Array(101).fill(issue1),
    }),
  ).toMatchObject({ status: "rejected" });
  const issues = Array.from({ length: 100 }, (_, i) => ({
    kind: "github",
    host:
      "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + ".example",
    owner: "d".repeat(39),
    repo: "e".repeat(100),
    number: i + 1,
  }));
  // Long local paths exercise UTF-8 entry bytes without widening Issue ref count.
  const path = ["tickets", ...Array(4).fill("あ".repeat(60)), "1.md"].join("/");
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), "ticket");
  const longIssues = Array.from({ length: 100 }, (_, i) => {
    const ticket = path.replace("1.md", `${i}.md`);
    writeFileSync(join(cwd, ticket), "ticket");
    return ticket;
  });
  expect(
    await app.link({ operation: "add_issues", issues: longIssues }),
  ).toMatchObject({ status: "rejected", errorCode: "entry_limit: 64 KiB" });
  expect(await app.link({ operation: "add_issues", issues })).toMatchObject({
    status: "saved",
  });
});

test("taskflow_evaluation_link and taskflow-evaluate never promote, block or resave legacy unresolved Planning", async () => {
  const { cwd, sessionDir } = workspace();
  const legacy = savedSession(cwd, sessionDir);
  const refs = [1, 2, 3].map((number) => ({
    kind: "github",
    host: "github.com",
    owner: "example",
    repo: "project",
    number,
  }));
  legacy.appendCustomEntry("pi-taskflow-evaluation.link", {
    version: 1,
    originSessionId: legacy.getSessionId(),
    phase: "planning",
    operation: "begin_planning",
    displayName: "Legacy",
    sourceIssues: refs.slice(0, 2),
    unresolved: "source_issues_unresolved",
  });
  legacy.appendCustomEntry("pi-taskflow-evaluation.link", {
    version: 1,
    originSessionId: legacy.getSessionId(),
    phase: "planning",
    operation: "add_issues",
    issues: [refs[2]],
  });
  const knownSession = savedSession(cwd, sessionDir);
  const known = runtime(knownSession);
  const task = await known.link({
    operation: "begin_planning",
    displayName: "Explicit",
  });
  await known.link({ operation: "add_issues", issues: [issue1] });
  const legacyBefore = readFileSync(legacy.getSessionFile()!);
  const legacyMemory = legacy.getEntries();
  const replan = savedSession(cwd, sessionDir);
  expect(
    await runtime(replan).link({
      operation: "begin_planning",
      displayName: "Reuse A",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({ status: "saved", taskflowId: resultTaskflowId(task) });
  // These rejected notifications have independent Sessions and read-only discovery sources.
  await Promise.all(
    [[refs[1]], [refs[2]], [refs[0], refs[1]]].map(async (sourceIssues) => {
      const manager = savedSession(cwd, sessionDir);
      const disk = readFileSync(manager.getSessionFile()!);
      const memory = manager.getEntries();
      expect(
        await runtime(manager).link({
          operation: "begin_planning",
          displayName: "No explicit mapping",
          sourceIssues,
        }),
      ).toEqual({
        status: "rejected",
        errorCode: "planning_source_issues_unresolved",
      });
      expect(readFileSync(manager.getSessionFile()!)).toEqual(disk);
      expect(manager.getEntries()).toEqual(memory);
    }),
  );
  const old = runtime(legacy);
  const expectLegacyRejection = async (notification: unknown) => {
    expect(await old.link(notification)).toEqual({
      status: "rejected",
      errorCode: "planning_legacy_unresolved",
    });
    expect(readFileSync(legacy.getSessionFile()!)).toEqual(legacyBefore);
    expect(legacy.getEntries()).toEqual(legacyMemory);
  };
  await expectLegacyRejection({
    operation: "begin_planning",
    displayName: "Legacy",
    sourceIssues: [issue1, issue2],
  });
  await expectLegacyRejection({ operation: "add_issues", issues: [refs[2]] });
  await expectLegacyRejection({ operation: "add_issues", issues: [refs[0]] });
  expect(
    await old.link({ operation: "implementation", issue: issue1 }),
  ).toEqual({
    status: "rejected",
    errorCode: "phase_switch_refused",
  });
  const list = await old.list();
  expect(list.complete).toBe(true);
  expect(list.candidates).toHaveLength(1);
  expect(list.candidates[0]).toMatchObject({
    taskflowId: resultTaskflowId(task),
    issues: [refs[0]],
    implementationSessionIds: [],
  });
  expect(list.candidates[0].planningSessionIds.toSorted()).toEqual(
    [knownSession.getSessionId(), replan.getSessionId()].toSorted(),
  );
  expect(list.unresolved).toContainEqual({
    sessionId: legacy.getSessionId(),
    reason: "source_issues_unresolved",
  });
  expect(readFileSync(legacy.getSessionFile()!)).toEqual(legacyBefore);
});

test.each([
  "missing-sourceIssues",
  "taskflowId-and-unresolved",
  "unknown-version",
])(
  "taskflow_evaluation_link and taskflow-evaluate reject malformed legacy begin %s without rescue",
  async (kind) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const ref = {
      kind: "github",
      host: "github.com",
      owner: "example",
      repo: "project",
      number: 1,
    };
    manager.appendCustomEntry("pi-taskflow-evaluation.link", {
      version: kind === "unknown-version" ? 2 : 1,
      originSessionId: manager.getSessionId(),
      phase: "planning",
      operation: "begin_planning",
      displayName: "Invalid legacy",
      unresolved: "source_issues_unresolved",
      ...(kind === "missing-sourceIssues" ? {} : { sourceIssues: [ref] }),
      ...(kind === "taskflowId-and-unresolved"
        ? { taskflowId: randomUUID() }
        : {}),
    });
    const before = readFileSync(manager.getSessionFile()!);
    const memory = manager.getEntries();
    const app = runtime(manager);
    expect(
      await app.link({
        operation: "begin_planning",
        displayName: "Invalid legacy",
        sourceIssues: [issue1],
      }),
    ).toMatchObject({
      status: "save_unconfirmed",
      errorCode: "session_source_unverified",
    });
    const list = await app.list();
    expect(list.complete).toBe(false);
    expect(list.candidates).toEqual([]);
    expect(list.warnings).toContainEqual(
      expect.objectContaining({ code: "unsupported_link_schema" }),
    );
    expect(manager.getEntries()).toEqual(memory);
    expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
  },
);

test("taskflow_evaluation_link refuses different and multiple explicit Taskflow ownership without changing memory or disk", async () => {
  const { cwd, sessionDir } = workspace();
  await Promise.all(
    [
      ["One", issue1],
      ["Two", issue2],
    ].map(async ([displayName, issue]) => {
      const app = runtime(savedSession(cwd, sessionDir));
      await app.link({ operation: "begin_planning", displayName });
      await app.link({ operation: "add_issues", issues: [issue] });
    }),
  );
  const mixed = savedSession(cwd, sessionDir);
  const mixedDisk = readFileSync(mixed.getSessionFile()!);
  const mixedMemory = mixed.getEntries();
  expect(
    await runtime(mixed).link({
      operation: "begin_planning",
      displayName: "Mixed",
      sourceIssues: [issue1, issue2],
    }),
  ).toEqual({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(readFileSync(mixed.getSessionFile()!)).toEqual(mixedDisk);
  expect(mixed.getEntries()).toEqual(mixedMemory);
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "One explicit",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({ status: "saved" });
  const duplicate = runtime(savedSession(cwd, sessionDir));
  await duplicate.link({
    operation: "begin_planning",
    displayName: "Conflicting owner",
  });
  await duplicate.link({ operation: "add_issues", issues: [issue1] });
  const ambiguous = savedSession(cwd, sessionDir);
  const disk = readFileSync(ambiguous.getSessionFile()!);
  const memory = ambiguous.getEntries();
  expect(
    await runtime(ambiguous).link({
      operation: "begin_planning",
      displayName: "Ambiguous",
      sourceIssues: [issue1],
    }),
  ).toEqual({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(readFileSync(ambiguous.getSessionFile()!)).toEqual(disk);
  expect(ambiguous.getEntries()).toEqual(memory);
  const list = await duplicate.list();
  expect(list.conflicts).toHaveLength(1);
  expect(list.conflicts[0].issue).toEqual({
    kind: "github",
    host: "github.com",
    owner: "example",
    repo: "project",
    number: 1,
  });
  expect(list.conflicts[0].taskflowIds).toHaveLength(2);
});

test.each([
  { role: "unsupportedFutureRole", content: [] },
  { role: "user", content: [{ type: "text" }] },
  {
    role: "user",
    content: [{ type: "toolCall", id: "x", name: "tool", arguments: {} }],
  },
  { role: "assistant", content: "not an assistant content array" },
  { role: "toolResult", content: [{ type: "text", text: "result" }] },
  { role: "assistant", content: [], usage: { input: "unsupported" } },
  "not an AgentMessage",
])(
  "taskflow-evaluate and taskflow_evaluation_link preserve valid membership despite unsupported conversation details %j",
  async (message) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const app = runtime(manager);
    const begin = await app.link({
      operation: "begin_planning",
      displayName: "Known",
    });
    await app.link({ operation: "add_issues", issues: [issue1] });
    const file = manager.getSessionFile()!;
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .split("\n")
        .map((line) => {
          if (!line) return line;
          const entry = JSON.parse(line);
          if (entry.type === "message")
            entry.message =
              typeof message === "string"
                ? message
                : { ...message, timestamp: Date.now() };
          return JSON.stringify(entry);
        })
        .join("\n"),
    );
    const before = readFileSync(file);
    const list = await app.list();
    expect(list.complete).toBe(true);
    expect(list.warnings).toEqual([]);
    expect(list.candidates).toHaveLength(1);
    expect(list.candidates[0].taskflowId).toBe(resultTaskflowId(begin));
    expect(
      await runtime(savedSession(cwd, sessionDir)).link({
        operation: "begin_planning",
        displayName: "Reuse",
        sourceIssues: [issue1],
      }),
    ).toMatchObject({ status: "saved", taskflowId: resultTaskflowId(begin) });
    expect(readFileSync(file)).toEqual(before);
  },
);

const expectedDefaults = {
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
test("taskflow-evaluate snapshots effective limits before waitForIdle, overlays single keys and keeps unrelated settings private", async () => {
  const { cwd, sessionDir } = workspace();
  let settings = {
    "taskflow-evaluation": { limits: { maxReportJsonMiB: 64 } },
    secret: "never-echo-this",
  };
  const app = runtime(savedSession(cwd, sessionDir), {
    settings: () => settings,
  });
  expect((await app.list()).effectiveLimits).toEqual({
    ...expectedDefaults,
    maxReportJsonMiB: 64,
  });
  const list = await app.list("--list", async () => {
    settings = {
      ...settings,
      "taskflow-evaluation": { limits: { maxReportJsonMiB: 128 } },
    };
  });
  expect(list.effectiveLimits.maxReportJsonMiB).toBe(64);
  expect((await app.list()).effectiveLimits.maxReportJsonMiB).toBe(128);
  expect(JSON.stringify(list)).not.toContain("never-echo-this");
  expect(
    (await runtime(savedSession(cwd, sessionDir)).list()).effectiveLimits,
  ).toEqual(expectedDefaults);
});

test.each([
  null,
  [],
  "secret-value",
  { unknown: 1 },
  { maxReadMiB: 0 },
  { maxFileMiB: -1 },
  { maxLineMiB: 1.5 },
  { maxSessionFiles: "1" },
  { maxReadMiB: Number.MAX_SAFE_INTEGER },
  { maxExcerptKiB: Number.MAX_SAFE_INTEGER },
])(
  "taskflow_evaluation_link and taskflow-evaluate reject invalid effective limits %j",
  async (limits) => {
    const { cwd, sessionDir } = workspace();
    const app = runtime(savedSession(cwd, sessionDir), {
      settings: () => ({
        "taskflow-evaluation": { limits },
        secret: "secret-value",
      }),
    });
    const tool = await app.link({
      operation: "begin_planning",
      displayName: "Invalid settings",
    });
    expect(tool).toMatchObject({ status: "rejected" });
    const list = await app.list();
    expect(list.status).toBe("not_updated");
    expect(list.errorCode).toContain("invalid_settings");
    expect(JSON.stringify([tool, list])).not.toContain("secret-value");
  },
);

test.each([
  ["unknown-version", "unsupported_session_header"],
  ["unknown-link", "unsupported_link_schema"],
  ["unfinished", "incomplete_tail"],
  ["malformed", "invalid_json_line"],
  ["large-line", "line_limit"],
  ["large-file", "file_limit"],
  ["nonregular", "unsafe_session_file"],
  ["symlink", "unsafe_session_file"],
])(
  "taskflow-evaluate marks %s incomplete and never proves unique ownership from a truncated search",
  async (kind, code) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const settingsValue = {
      "taskflow-evaluation": { limits: { maxFileMiB: 1, maxLineMiB: 1 } },
    };
    const settings = () => settingsValue;
    const app = runtime(manager, { settings });
    await app.link({ operation: "begin_planning", displayName: "Known" });
    await app.link({ operation: "add_issues", issues: [issue1] });
    const bad = savedSession(cwd, sessionDir);
    const file = bad.getSessionFile()!;
    if (kind === "unknown-version")
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace('"version":3', '"version":99'),
      );
    if (kind === "unknown-link")
      bad.appendCustomEntry("pi-taskflow-evaluation.link", { version: 99 });
    if (kind === "unfinished") appendFileSync(file, '{"type":"custom"');
    if (kind === "malformed") appendFileSync(file, "{bad json}\n");
    if (kind === "large-line") {
      // The line limit is independent from the general file limit.
      appendFileSync(
        file,
        JSON.stringify({ text: "x".repeat(1048576) }) + "\n",
      );
    }
    if (kind === "large-file") appendFileSync(file, " ".repeat(1048577));
    if (kind === "nonregular") {
      rmSync(file);
      mkdirSync(file);
    }
    if (kind === "symlink") {
      rmSync(file);
      symlinkSync(manager.getSessionFile()!, file);
    }
    const boundaryApp =
      kind === "large-line"
        ? runtime(manager, {
            settings: () => ({
              "taskflow-evaluation": {
                limits: { maxFileMiB: 2, maxLineMiB: 1 },
              },
            }),
          })
        : app;
    const before = readFileSync(manager.getSessionFile()!);
    const list = await boundaryApp.list();
    expect(list.complete).toBe(false);
    expect(list.warnings).toContainEqual(expect.objectContaining({ code }));
    const rejected = savedSession(cwd, sessionDir);
    const rejectedDisk = readFileSync(rejected.getSessionFile()!);
    const rejectedMemory = rejected.getEntries();
    expect(
      await runtime(rejected, {
        settings:
          kind === "large-line"
            ? () => ({
                "taskflow-evaluation": {
                  limits: { maxFileMiB: 2, maxLineMiB: 1 },
                },
              })
            : settings,
      }).link({
        operation: "begin_planning",
        displayName: "No reuse",
        sourceIssues: [issue1],
      }),
    ).toEqual({
      status: "rejected",
      errorCode: "planning_source_issues_unresolved",
    });
    expect(readFileSync(rejected.getSessionFile()!)).toEqual(rejectedDisk);
    expect(rejected.getEntries()).toEqual(rejectedMemory);
    expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
  },
);

test.each([
  "header-id",
  "entry-id",
  "duplicate-entry-id",
  "parent-id",
  "link-origin",
])(
  "taskflow-evaluate and taskflow_evaluation_link retain identity validation for %s",
  async (kind) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const app = runtime(manager);
    await app.link({ operation: "begin_planning", displayName: "Identity" });
    await app.link({ operation: "add_issues", issues: [issue1] });
    const file = manager.getSessionFile()!;
    const entries = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (kind === "header-id") entries[0].id = "../not-a-session";
    if (kind === "entry-id") entries[1].id = "";
    if (kind === "duplicate-entry-id") entries[2].id = entries[1].id;
    if (kind === "parent-id") entries[2].parentId = "absent-parent";
    if (kind === "link-origin") entries[2].data.originSessionId = "";
    writeFileSync(
      file,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const disk = readFileSync(file);
    const memory = manager.getEntries();
    const list = await app.list();
    expect(list.complete).toBe(false);
    expect(list.candidates).toEqual([]);
    expect(
      await app.link({ operation: "add_issues", issues: [issue1] }),
    ).toMatchObject({
      status: "save_unconfirmed",
      errorCode: "session_source_unverified",
    });
    const replan = savedSession(cwd, sessionDir);
    const replanDisk = readFileSync(replan.getSessionFile()!);
    const replanMemory = replan.getEntries();
    expect(
      await runtime(replan).link({
        operation: "begin_planning",
        displayName: "No guess",
        sourceIssues: [issue1],
      }),
    ).toMatchObject({
      status: "rejected",
      errorCode: "planning_source_issues_unresolved",
    });
    expect(readFileSync(replan.getSessionFile()!)).toEqual(replanDisk);
    expect(replan.getEntries()).toEqual(replanMemory);
    expect(readFileSync(file)).toEqual(disk);
    expect(manager.getEntries()).toEqual(memory);
  },
);

test("taskflow-evaluate candidate and total-byte bounds prevent reuse and explain the setting/retry condition", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  await app.link({ operation: "begin_planning", displayName: "Known" });
  await app.link({ operation: "add_issues", issues: [issue1] });
  const another = savedSession(cwd, sessionDir);
  const candidateLimited = runtime(another, {
    settings: () => ({
      "taskflow-evaluation": { limits: { maxSessionFiles: 1 } },
    }),
  });
  expect((await candidateLimited.list()).warnings).toContainEqual(
    expect.objectContaining({
      code: "candidate_limit",
      key: "maxSessionFiles",
      value: 1,
    }),
  );
  const beforeLimited = readFileSync(another.getSessionFile()!);
  const memoryLimited = another.getEntries();
  expect(
    await candidateLimited.link({
      operation: "begin_planning",
      displayName: "Incomplete",
      sourceIssues: [issue1],
    }),
  ).toEqual({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(readFileSync(another.getSessionFile()!)).toEqual(beforeLimited);
  expect(another.getEntries()).toEqual(memoryLimited);
  another.appendMessage({
    role: "user",
    content: "x".repeat(700000),
    timestamp: Date.now(),
  });
  const large = savedSession(cwd, sessionDir);
  large.appendMessage({
    role: "user",
    content: "x".repeat(700000),
    timestamp: Date.now(),
  });
  const byteLimited = runtime(manager, {
    settings: () => ({ "taskflow-evaluation": { limits: { maxReadMiB: 1 } } }),
  });
  const list = await byteLimited.list();
  expect(list.complete).toBe(false);
  expect(list.warnings).toContainEqual(
    expect.objectContaining({
      code: "read_limit",
      key: "maxReadMiB",
      value: 1,
    }),
  );
  expect(
    list.warnings.some((warning: { resume: string }) =>
      warning.resume.includes("/reload"),
    ),
  ).toBe(true);
});

test("public Pi loader, registered tool and SDK command prompt work with effective Settings trust, merge and reload without model calls", async () => {
  const { cwd, sessionDir } = workspace();
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "taskflow-evaluation": {
        limits: { maxSessionFiles: 20, maxReportJsonMiB: 64 },
      },
    }),
  );
  const projectSettings = join(cwd, ".pi", "settings.json");
  writeFileSync(
    projectSettings,
    JSON.stringify({
      "taskflow-evaluation": { limits: { maxSessionFiles: 10, maxLineMiB: 3 } },
    }),
  );
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const modelCalls = [
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
  ] as const;
  const modelGuards = modelCalls.map((method) =>
    vi.spyOn(modelRuntime, method).mockImplementation(() => {
      throw new Error("model calls forbidden");
    }),
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    additionalExtensionPaths: [resolve("src/index.ts")],
    additionalSkillPaths: [resolve("skills")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([
    "taskflow-evaluation",
  ]);
  expect(loader.getSkills().diagnostics).toEqual([]);
  const manager = savedSession(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime,
    noTools: "builtin",
  });
  const lines: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original receiver below.
  const originalWrite = Writable.prototype.write;
  const output = vi
    .spyOn(Writable.prototype, "write")
    .mockImplementation(function (
      this: Writable,
      chunk,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      if (
        this === process.stdout &&
        String(chunk).startsWith("TASKFLOW_EVALUATION_RESULT ")
      ) {
        lines.push(String(chunk));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (!done) throw new Error("receipt callback missing");
        done();
        return true;
      }
      return Reflect.apply(originalWrite, this, [
        chunk,
        encodingOrCallback,
        callback,
      ]);
    });
  try {
    await session.bindExtensions({ mode: "print" });
    const tool = session.extensionRunner.getToolDefinition(
      "taskflow_evaluation_link",
    )!;
    const result = await tool.execute(
      "probe",
      { operation: "begin_planning", displayName: "SDK loaded" },
      undefined,
      undefined,
      session.extensionRunner.createToolContext("probe", undefined),
    );
    expect(result.details).toMatchObject({ status: "saved" });
    const list = async (args = "--list") => {
      lines.length = 0;
      await session.prompt(`/taskflow-evaluate ${args}`);
      const line = lines.find((value) =>
        value.startsWith("TASKFLOW_EVALUATION_RESULT "),
      )!;
      expect(line.split("\n")).toHaveLength(2);
      return JSON.parse(line.slice("TASKFLOW_EVALUATION_RESULT ".length));
    };
    const untrusted = await list();
    expect(untrusted.candidates[0].displayName).toBe("SDK loaded");
    expect(untrusted.effectiveLimits).toEqual({
      ...expectedDefaults,
      maxSessionFiles: 20,
      maxReportJsonMiB: 64,
    });
    settings.setProjectTrusted(true);
    await settings.reload();
    expect((await list()).effectiveLimits).toEqual({
      ...expectedDefaults,
      maxSessionFiles: 10,
      maxLineMiB: 3,
      maxReportJsonMiB: 64,
    });
    writeFileSync(
      projectSettings,
      JSON.stringify({
        "taskflow-evaluation": { limits: { maxSessionFiles: 7 } },
      }),
    );
    await session.reload();
    expect((await list()).effectiveLimits).toEqual({
      ...expectedDefaults,
      maxSessionFiles: 7,
      maxReportJsonMiB: 64,
    });
    const sourceBefore = readFileSync(manager.getSessionFile()!);
    const collected = await list(
      `--taskflow ${resultTaskflowId(result.details)}`,
    );
    expect(collected).toMatchObject({
      status: "updated",
      jsonCommitted: true,
      htmlUpdated: true,
    });
    expect(
      JSON.parse(readFileSync(collected.files.json, "utf8")).contentDigest,
    ).toBe(collected.contentDigest);
    expect(readFileSync(manager.getSessionFile()!)).toEqual(sourceBefore);
    expect(modelGuards.every((guard) => guard.mock.calls.length === 0)).toBe(
      true,
    );
  } finally {
    output.mockRestore();
    for (const guard of modelGuards) guard.mockRestore();
    session.dispose();
  }
});

test("taskflow-evaluate waits for receipt completion and leaves redirected stdout reusable", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const runner = await registeredRuntime(manager);
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original receiver below.
  const originalWrite = Writable.prototype.write;
  const lines: string[] = [];
  let complete: ((error?: Error | null) => void) | undefined;
  const existingListener = vi.fn();
  process.stdout.on("error", existingListener);
  const listeners = process.stdout.listeners("error");
  const output = vi
    .spyOn(Writable.prototype, "write")
    .mockImplementation(function (
      this: Writable,
      chunk,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      if (
        this === process.stdout &&
        String(chunk).startsWith("TASKFLOW_EVALUATION_RESULT ")
      ) {
        lines.push(String(chunk));
        complete =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (!complete) throw new Error("receipt callback missing");
        return false;
      }
      return Reflect.apply(originalWrite, this, [
        chunk,
        encodingOrCallback,
        callback,
      ]);
    });
  const redirectedWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const before = readFileSync(manager.getSessionFile()!);
  try {
    let completed = false;
    const pending = runner
      .getCommand("taskflow-evaluate")!
      .handler("--list", runner.createCommandContext())
      .then(() => {
        completed = true;
      });
    await new Promise((resolveDone) => setImmediate(resolveDone));
    expect(lines).toHaveLength(1);
    expect(completed).toBe(false);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(
      JSON.parse(lines[0].slice("TASKFLOW_EVALUATION_RESULT ".length)),
    ).toMatchObject({ status: "listed" });
    complete!();
    await pending;
    expect(process.stdout.listeners("error")).toEqual(listeners);
    expect(process.stdout.destroyed).toBe(false);
    expect(process.stdout.writableEnded).toBe(false);
    expect(redirectedWrite).not.toHaveBeenCalled();
    process.stdout.write("reused");
    expect(redirectedWrite).toHaveBeenCalledWith("reused");
    expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
  } finally {
    redirectedWrite.mockRestore();
    output.mockRestore();
    process.stdout.removeListener("error", existingListener);
  }
});

test.each(["throw", "callback", "callback-only", "event"])(
  "taskflow-evaluate propagates stdout %s failure and preserves existing error listeners",
  async (fault) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const runner = await registeredRuntime(manager);
    const error = new Error("stdout write failed");
    const existingListener = vi.fn();
    process.stdout.on("error", existingListener);
    const listeners = process.stdout.listeners("error");
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original receiver below.
    const originalWrite = Writable.prototype.write;
    const output = vi
      .spyOn(Writable.prototype, "write")
      .mockImplementation(function (
        this: Writable,
        chunk,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) {
        if (
          this !== process.stdout ||
          !String(chunk).startsWith("TASKFLOW_EVALUATION_RESULT ")
        )
          return Reflect.apply(originalWrite, this, [
            chunk,
            encodingOrCallback,
            callback,
          ]);
        if (fault === "throw") throw error;
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (!done) throw new Error("receipt callback missing");
        if (fault === "callback" || fault === "callback-only") {
          done(error);
          if (fault === "callback")
            process.nextTick(() => process.stdout.emit("error", error));
        } else {
          process.nextTick(() => {
            process.stdout.emit("error", error);
            done();
          });
        }
        return false;
      });
    const before = readFileSync(manager.getSessionFile()!);
    try {
      await expect(
        runner
          .getCommand("taskflow-evaluate")!
          .handler("--list", runner.createCommandContext()),
      ).rejects.toBe(error);
      await new Promise((resolveDone) => setImmediate(resolveDone));
      expect(process.stdout.listeners("error")).toEqual(listeners);
      expect(existingListener.mock.calls.length).toBe(
        fault === "throw" || fault === "callback-only" ? 0 : 1,
      );
      expect(process.stdout.destroyed).toBe(false);
      expect(process.stdout.writableEnded).toBe(false);
      expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
    } finally {
      output.mockRestore();
      process.stdout.removeListener("error", existingListener);
    }
  },
);

test.each(["text", "json"])(
  "public Pi CLI %s repeatedly lists 100 Planning and 100 Implementation Sessions with 100 Issue refs",
  async (mode) => {
    const cwd = realpathSync(workspace().cwd);
    const sessionDir = join(cwd, "sessions");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }),
    );
    const expected = new Map<
      string,
      { planning: string; implementation: string; number: number }
    >();
    for (let i = 0; i < 100; i++) {
      const planning = savedSession(cwd, sessionDir);
      const taskflowId = randomUUID();
      planning.appendCustomEntry("pi-taskflow-evaluation.link", {
        version: 1,
        originSessionId: planning.getSessionId(),
        phase: "planning",
        operation: "begin_planning",
        taskflowId,
        displayName: `CLI fixture ${i}`,
      });
      const issues = [
        {
          kind: "github",
          host: "github.com",
          owner: "example",
          repo: "project",
          number: i + 1,
        },
      ];
      planning.appendCustomEntry("pi-taskflow-evaluation.link", {
        version: 1,
        originSessionId: planning.getSessionId(),
        phase: "planning",
        operation: "add_issues",
        issues,
      });
      const implementation = savedSession(cwd, sessionDir);
      implementation.appendCustomEntry("pi-taskflow-evaluation.link", {
        version: 1,
        originSessionId: implementation.getSessionId(),
        phase: "implementation",
        operation: "implementation",
        issues: [issues[0]],
      });
      expected.set(taskflowId, {
        planning: planning.getSessionId(),
        implementation: implementation.getSessionId(),
        number: i + 1,
      });
    }
    const filesBefore = readdirSync(sessionDir);
    const sourcesBefore = filesBefore.map((file) =>
      readFileSync(join(sessionDir, file)),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    };
    for (const key of Object.keys(env)) {
      if (
        key.endsWith("_API_KEY") ||
        /^(ANTHROPIC|OPENAI|GOOGLE|AZURE|GEMINI|COPILOT|GITHUB)_/.test(key)
      )
        delete env[key];
    }
    const cliArgs = [
      resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      ),
      "--offline",
      "--no-extensions",
      "-e",
      resolve("src/index.ts"),
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      "--session-dir",
      sessionDir,
      "--print",
      "--mode",
      mode,
      "/taskflow-evaluate --list",
    ];
    const runAttempt = async (attempt: number) => {
      const startedAt = Date.now();
      let result;
      if (attempt === 1) {
        // Pause the real pipe reader to force Node to retain the single receipt chunk.
        result = await new Promise<{
          stdout: string;
          stderr: string;
          status: number | null;
          signal: NodeJS.Signals | null;
          error?: Error;
        }>((resolveResult, reject) => {
          const child = spawn(process.execPath, cliArgs, {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("CLI timeout"));
          }, 30000);
          child.stdout.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
            child.stdout.pause();
            setTimeout(() => child.stdout.resume(), 10);
          });
          child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
          child.on("error", reject);
          child.on("close", (status, signal) => {
            clearTimeout(timer);
            resolveResult({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              status,
              signal,
            });
          });
        });
      } else if (attempt === 2) {
        const file = join(cwd, "receipt.txt");
        const fd = openSync(file, "w");
        try {
          result = {
            ...spawnSync(process.execPath, cliArgs, {
              cwd,
              env,
              timeout: 30000,
              encoding: "utf8",
              stdio: ["ignore", fd, "pipe"],
            }),
            stdout: readFileSync(file, "utf8"),
          };
        } finally {
          closeSync(fd);
        }
      } else {
        result = spawnSync(process.execPath, cliArgs, {
          cwd,
          env,
          timeout: 30000,
          maxBuffer: 64 * 1048576,
          encoding: "utf8",
        });
      }
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const { stdout, stderr } = result;
      const receipts = stdout
        .split("\n")
        .filter((line) => line.startsWith("TASKFLOW_EVALUATION_RESULT "));
      expect(receipts).toHaveLength(1);
      expect(stderr).not.toContain("TASKFLOW_EVALUATION_RESULT ");
      expect(stderr).not.toMatch(
        /command error|Error in command|EPIPE|ERR_SYSTEM_ERROR/i,
      );
      expect(stdout.endsWith("\n")).toBe(true);
      const otherLines = stdout
        .split("\n")
        .filter(
          (line) => line && !line.startsWith("TASKFLOW_EVALUATION_RESULT "),
        );
      if (mode === "json") {
        expect(otherLines).toHaveLength(1);
        expect(JSON.parse(otherLines[0])).toMatchObject({ type: "session" });
      } else expect(otherLines).toEqual([]);
      let receipt;
      try {
        receipt = JSON.parse(
          receipts[0].slice("TASKFLOW_EVALUATION_RESULT ".length),
        );
      } catch (error) {
        const position = Number(/position (\d+)/.exec(String(error))?.[1]);
        process.stderr.write(
          JSON.stringify({
            mode,
            exit: result.status,
            signal: result.signal,
            stderr,
            elapsedMs: Date.now() - startedAt,
            stdoutBytes: Buffer.byteLength(stdout),
            trailingLF: stdout.endsWith("\n"),
            receiptBytes: Buffer.byteLength(receipts[0]),
            position,
            aroundPosition: receipts[0].slice(
              Math.max(0, position - 80),
              position + 160,
            ),
            headerOffset: stdout.indexOf('{"type":"session"'),
            stdoutStart: stdout.slice(0, 240),
            stdoutEnd: stdout.slice(-240),
          }) + "\n",
        );
        throw error;
      }
      expect(receipt).toMatchObject({
        status: "listed",
        complete: true,
        warnings: [],
        jsonCommitted: false,
        htmlUpdated: false,
        scope: { cwd, sessionDir },
      });
      expect(
        receipt.candidates
          .map((candidate: { taskflowId: string }) => candidate.taskflowId)
          .toSorted(),
      ).toEqual([...expected.keys()].toSorted());
      expect(receipt.candidates).toHaveLength(100);
      for (const candidate of receipt.candidates) {
        const run = expected.get(candidate.taskflowId)!;
        expect(candidate.planningSessionIds).toEqual([run.planning]);
        expect(candidate.implementationSessionIds).toEqual([
          run.implementation,
        ]);
        expect(candidate.issues).toEqual([
          {
            kind: "github",
            host: "github.com",
            owner: "example",
            repo: "project",
            number: run.number,
          },
        ]);
        expect(candidate.missingImplementationIssues).toEqual([]);
      }
      expect(receipt.unresolved).toEqual([]);
      expect(receipt.conflicts).toEqual([]);
      expect(receipt.effectiveLimits).toEqual(expectedDefaults);
      const elapsedMs = Date.now() - startedAt;
      const stdoutBytes = Buffer.byteLength(stdout);
      expect(elapsedMs).toBeLessThan(30000);
      expect(stdoutBytes).toBeGreaterThan(0);
      process.stdout.write(
        JSON.stringify({ mode, attempt, elapsedMs, stdoutBytes }) + "\n",
      );
      expect(stdout).not.toContain('"type":"message_start"');
      expect(readdirSync(sessionDir)).toEqual(filesBefore);
      filesBefore.forEach((file, i) =>
        expect(
          readFileSync(join(sessionDir, file)).equals(sourcesBefore[i]),
        ).toBe(true),
      );
      expect(fs.existsSync(join(cwd, ".pi", "taskflow-reports"))).toBe(false);
    };
    await runAttempt(0);
    await runAttempt(1);
    await runAttempt(2);
  },
  120000,
);

test("taskflow-evaluate distinguishes normal append after the start boundary from rewritten-prefix growth", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  await app.link({ operation: "begin_planning", displayName: "Original" });
  const file = manager.getSessionFile()!;
  const originalRead = fs.readSync;
  let changed = false;
  const guard = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const result = Reflect.apply(originalRead, fs, args);
    if (!changed) {
      changed = true;
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("Original", "Replaced"),
      );
      appendFileSync(file, '{"incomplete":');
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const list = await app.list();
    expect(list.complete).toBe(false);
    expect(list.warnings).toContainEqual(
      expect.objectContaining({ code: "session_file_changed" }),
    );
    expect(list.candidates).toEqual([]);
  } finally {
    guard.mockRestore();
    syncBuiltinESMExports();
  }
});

test("taskflow-evaluate retains only the initial byte boundary during normal append and never reuses incomplete discovery", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  await app.link({ operation: "begin_planning", displayName: "Snapshot" });
  const originalRead = fs.readSync;
  let changed = false;
  const guard = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const result = Reflect.apply(originalRead, fs, args);
    if (!changed) {
      changed = true;
      manager.appendCustomEntry("pi-taskflow-evaluation.link", {
        version: 1,
        originSessionId: manager.getSessionId(),
        phase: "planning",
        operation: "add_issues",
        issues: [
          {
            kind: "github",
            host: "github.com",
            owner: "example",
            repo: "project",
            number: 1,
          },
        ],
      });
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const list = await app.list();
    expect(list.complete).toBe(false);
    expect(list.warnings).toContainEqual(
      expect.objectContaining({ code: "appended_after_boundary" }),
    );
    expect(list.candidates[0].issues).toEqual([]);
  } finally {
    guard.mockRestore();
    syncBuiltinESMExports();
  }
  expect((await app.list()).candidates[0].issues).toHaveLength(1);
});

test("taskflow-evaluate refuses shortened files and conflicting origin registrations rather than repairing them", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  await app.link({ operation: "begin_planning", displayName: "Recorded" });
  const originalRead = fs.readSync;
  let changed = false;
  const guard = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const result = Reflect.apply(originalRead, fs, args);
    if (!changed) {
      changed = true;
      writeFileSync(manager.getSessionFile()!, "");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const list = await app.list();
    expect(list.complete).toBe(false);
    expect(list.warnings).toContainEqual(
      expect.objectContaining({ code: "session_file_changed" }),
    );
  } finally {
    guard.mockRestore();
    syncBuiltinESMExports();
  }
  const conflicting = savedSession(cwd, sessionDir);
  const other = runtime(conflicting);
  await other.link({ operation: "begin_planning", displayName: "One phase" });
  conflicting.appendCustomEntry("pi-taskflow-evaluation.link", {
    version: 1,
    originSessionId: conflicting.getSessionId(),
    phase: "implementation",
    operation: "implementation",
    issues: [
      {
        kind: "github",
        host: "github.com",
        owner: "example",
        repo: "project",
        number: 1,
      },
    ],
  });
  const before = readFileSync(conflicting.getSessionFile()!);
  expect(
    await other.link({ operation: "implementation", issue: issue1 }),
  ).toMatchObject({ status: "rejected", errorCode: "registration_conflict" });
  expect((await other.list()).unresolved).toContainEqual({
    sessionId: conflicting.getSessionId(),
    reason: "registration_conflict",
  });
  expect(readFileSync(conflicting.getSessionFile()!)).toEqual(before);
});

test("taskflow-evaluate collects Root reports and explicit bash observations without changing logs", async () => {
  const { cwd, sessionDir } = workspace();
  const planning = SessionManager.create(cwd, sessionDir);
  planning.appendMessage({
    role: "user",
    content: "Plan <script>alert(1)</script>",
    timestamp: Date.now(),
  });
  const app = runtime(planning);
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Delivery" }),
  );
  await app.link({
    operation: "add_issues",
    issues: ["https://github.com/example/project/issues/2"],
  });
  const implementation = SessionManager.create(cwd, sessionDir);
  implementation.appendMessage({
    role: "user",
    content: "Implement",
    timestamp: Date.now(),
  });
  await runtime(implementation).link({
    operation: "implementation",
    issue: "https://github.com/example/project/issues/2",
  });
  implementation.appendMessage({
    role: "bashExecution",
    command: "pnpm test",
    output: "passed",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.now(),
  });
  const before = readFileSync(implementation.getSessionFile()!);
  const receipt = await app.list("https://github.com/example/project/issues/2");
  expect(receipt).toMatchObject({
    status: "updated",
    taskflowId: id,
    jsonCommitted: true,
    htmlUpdated: true,
  });
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  expect(report).toMatchObject({
    schemaVersion: 1,
    taskflowId: id,
    contentDigest: receipt.contentDigest,
  });
  expect(
    report.roots
      .map((root: { sessionId: string }) => root.sessionId)
      .toSorted(),
  ).toEqual(
    [planning.getSessionId(), implementation.getSessionId()].toSorted(),
  );
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "exit",
        value: 0,
        provenance: expect.objectContaining({
          sessionId: implementation.getSessionId(),
          field: "message.exitCode",
        }),
      }),
    ]),
  );
  const html = readFileSync(receipt.files.html, "utf8");
  expect(html).toContain(receipt.contentDigest);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(fs.statSync(receipt.files.json).mode & 0o777).toBe(0o600);
  expect(
    fs.statSync(join(cwd, ".pi", "taskflow-reports", id)).mode & 0o777,
  ).toBe(0o700);
  expect(readFileSync(implementation.getSessionFile()!)).toEqual(before);
});

test("taskflow-evaluate preserves immutable evidence and saved explicit ownership after source loss", async () => {
  const { cwd, sessionDir } = workspace();
  const planning = SessionManager.create(cwd, sessionDir);
  planning.appendMessage({
    role: "user",
    content: "Original request",
    timestamp: Date.now(),
  });
  const app = runtime(planning);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Saved delivery",
    }),
  );
  await app.link({
    operation: "add_issues",
    issues: ["https://github.com/example/project/issues/3"],
  });
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  const original = JSON.parse(readFileSync(first.files.json, "utf8"));
  const firstEntry = planning.getEntries()[0];
  const source = readFileSync(planning.getSessionFile()!, "utf8");
  writeFileSync(
    planning.getSessionFile()!,
    source.replace("Original request", "Changed request"),
  );
  const changed = await app.list(`--taskflow ${id}`);
  expect(changed.jsonCommitted).toBe(true);
  const merged = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(merged.conflicts).toEqual(
    expect.arrayContaining([expect.stringContaining(firstEntry.id)]),
  );
  expect(
    merged.observations
      .filter((o: { kind: string }) => o.kind === "request")
      .map((o: { value: string }) => o.value),
  ).toEqual(["Original request", "Changed request"]);
  rmSync(planning.getSessionFile()!);
  const replan = SessionManager.create(cwd, sessionDir);
  replan.appendMessage({
    role: "user",
    content: "Replan",
    timestamp: Date.now(),
  });
  const reuse = await runtime(replan).link({
    operation: "begin_planning",
    displayName: "Replan",
    sourceIssues: ["https://github.com/example/project/issues/3"],
  });
  expect(reuse).toMatchObject({ status: "saved", taskflowId: id });
  const lost = await runtime(replan).list(
    "https://github.com/example/project/issues/3",
  );
  expect(lost).toMatchObject({ jsonCommitted: true, htmlUpdated: true });
  const preserved = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(
    preserved.roots.find(
      (root: { sessionId: string }) =>
        root.sessionId === planning.getSessionId(),
    ),
  ).toMatchObject({ availability: "missing_or_unread" });
  expect(preserved.observations.length).toBeGreaterThan(
    original.observations.length,
  );
});

test("taskflow-evaluate quarantines saved evidence on later tree detection and keeps it after shortening", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "user",
    content: "First branch",
    timestamp: Date.now(),
  });
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Branches" }),
  );
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  const file = manager.getSessionFile()!;
  const initial = readFileSync(file, "utf8");
  const entries = manager.getEntries();
  appendFileSync(
    file,
    `${JSON.stringify({ type: "branch_summary", id: "branch-later", parentId: entries[0].id, timestamp: new Date().toISOString(), fromId: entries.at(-1)!.id, summary: "Another branch" })}\n`,
  );
  const detected = await app.list(`--taskflow ${id}`);
  expect(detected.jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.roots[0].quarantine).toContain("recorded_tree_navigation");
  writeFileSync(file, initial);
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.roots[0]).toMatchObject({
    availability: "shortened",
    latestReportKey: null,
  });
  expect(report.roots[0].quarantine).toContain("recorded_tree_navigation");
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "summary", value: "Another branch" }),
    ]),
  );
});

test("taskflow-evaluate redacts known secrets and excludes replay payloads from Root evidence", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "user",
    content:
      'Authorization: Bearer sensitive-value password="secret with spaces" https://user:credential@example.com ghp_abcdefghijklmnop1234567890',
    timestamp: Date.now(),
  });
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Redaction" }),
  );
  const entries = manager.getEntries();
  appendFileSync(
    manager.getSessionFile()!,
    `${JSON.stringify({
      type: "message",
      id: "assistant-safe",
      parentId: entries.at(-1)!.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "PRIVATE THINKING",
            thinkingSignature: "SIGNATURE",
          },
          { type: "text", text: "Reported READY_FOR_MERGE" },
          {
            type: "toolCall",
            id: "child",
            name: "subagent",
            arguments: {
              token: "STRUCTURED SECRET",
              password: "PASSWORD",
              content: [{ type: "image", data: "BASE64 IMAGE" }],
            },
          },
        ],
      },
    })}\n`,
  );
  const receipt = await app.list(`--taskflow ${id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const json = readFileSync(receipt.files.json, "utf8");
  for (const secret of [
    "sensitive-value",
    "secret with spaces",
    "credential",
    "ghp_abcdefghijklmnop1234567890",
    "PRIVATE THINKING",
    "SIGNATURE",
    "STRUCTURED SECRET",
    "PASSWORD",
    "BASE64 IMAGE",
  ])
    expect(json).not.toContain(secret);
  expect(json).toContain("[REDACTED]");
  expect(receipt.warnings).toContain("known_secret_redaction_applied");
});

test.each(["tui", "rpc"] as const)(
  "taskflow-evaluate %s selection and cancellation use public dialog boundaries without conversation additions",
  async (mode) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const id = resultTaskflowId(
      await runtime(manager).link({
        operation: "begin_planning",
        displayName: "UI delivery",
      }),
    );
    const runner = await registeredRuntime(manager);
    const notices: string[] = [];
    let choose = false;
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        select: async (_title, choices) =>
          choose
            ? choices.find((choice) => choice.includes("UI delivery"))
            : undefined,
        notify: (text) => {
          notices.push(text);
        },
      },
      mode,
    );
    const context = runner.createCommandContext();
    context.waitForIdle = async () => {};
    const before = readFileSync(manager.getSessionFile()!);
    await runner.getCommand("taskflow-evaluate")!.handler("", context);
    expect(notices.at(-1)).toContain('"status":"cancelled"');
    expect(fs.existsSync(join(cwd, ".pi", "taskflow-reports", id))).toBe(false);
    choose = true;
    await runner.getCommand("taskflow-evaluate")!.handler("", context);
    expect(notices.at(-1)).toContain('"jsonCommitted":true');
    expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
  },
);

test("taskflow-evaluate keeps the old pair on schema, lock, permission and symlink failures", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Safety" }),
  );
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  const json = readFileSync(first.files.json);
  const page = readFileSync(first.files.html);
  const lock = join(cwd, ".pi", "taskflow-reports", id, "report.lock");
  writeFileSync(lock, "foreign lock", { mode: 0o600 });
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "report_busy",
    jsonCommitted: false,
  });
  expect(readFileSync(lock, "utf8")).toBe("foreign lock");
  rmSync(lock);
  fs.chmodSync(first.files.json, 0o644);
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "report_permissions",
    jsonCommitted: false,
  });
  fs.chmodSync(first.files.json, 0o600);
  writeFileSync(first.files.json, '{"schemaVersion":99}');
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "invalid_report_schema",
    jsonCommitted: false,
  });
  expect(readFileSync(first.files.json, "utf8")).toBe('{"schemaVersion":99}');
  writeFileSync(first.files.json, json);
  rmSync(first.files.html);
  const external = join(cwd, "outside.html");
  writeFileSync(external, "outside");
  symlinkSync(external, first.files.html);
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "unsafe_report_path",
    jsonCommitted: false,
  });
  expect(readFileSync(first.files.json)).toEqual(json);
  expect(readFileSync(external, "utf8")).toBe("outside");
  rmSync(first.files.html);
  writeFileSync(first.files.html, page, { mode: 0o600 });
});

test.each(["temp", "json", "html"] as const)(
  "taskflow-evaluate %s filesystem failure preserves commit boundaries and supports next-run HTML repair",
  async (phase) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const app = runtime(manager);
    const id = resultTaskflowId(
      await app.link({
        operation: "begin_planning",
        displayName: "Commit boundary",
      }),
    );
    const first = await app.list(`--taskflow ${id}`);
    const oldJson = readFileSync(first.files.json);
    const oldHtml = readFileSync(first.files.html);
    manager.appendMessage({
      role: "user",
      content: "New observation",
      timestamp: Date.now(),
    });
    const originalOpen = fs.openSync;
    const originalRename = fs.renameSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (phase === "temp" && String(args[0]).endsWith(".html.tmp"))
        throw new Error("temp failure");
      if (
        phase === "temp" &&
        String(args[0]).includes("report.html.") &&
        String(args[0]).endsWith(".tmp")
      )
        throw new Error("temp failure");
      return originalOpen(...args);
    });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (
        phase !== "temp" &&
        String(to).endsWith(`report.${phase === "json" ? "json" : "html"}`)
      )
        throw new Error("rename failure");
      originalRename(from, to);
    });
    syncBuiltinESMExports();
    let receipt;
    try {
      receipt = await app.list(`--taskflow ${id}`);
    } finally {
      open.mockRestore();
      rename.mockRestore();
      syncBuiltinESMExports();
    }
    expect(receipt).toMatchObject({
      jsonCommitted: phase === "html",
      htmlUpdated: false,
    });
    expect(readFileSync(first.files.html)).toEqual(oldHtml);
    if (phase !== "html")
      expect(readFileSync(first.files.json)).toEqual(oldJson);
    else {
      expect(receipt).toMatchObject({
        status: "partial_success",
        errorCode: "html_update_failed",
      });
      expect(readFileSync(first.files.json)).not.toEqual(oldJson);
    }
    const repaired = await app.list(`--taskflow ${id}`);
    expect(repaired).toMatchObject({ jsonCommitted: true, htmlUpdated: true });
    if (phase === "html")
      expect(repaired.warnings).toContain(
        "html_digest_mismatch; regenerated from canonical JSON",
      );
    expect(readFileSync(first.files.html, "utf8")).toContain(
      repaired.contentDigest,
    );
    expect(
      readdirSync(join(cwd, ".pi", "taskflow-reports", id)).toSorted(),
    ).toEqual(["report.html", "report.json"]);
  },
);

test("taskflow-evaluate merge limits and dedicated saved JSON limit stop without discarding the old pair", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  let limits: Record<string, number> = {};
  const app = runtime(manager, {
    settings: () => ({ "taskflow-evaluation": { limits } }),
  });
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Limits" }),
  );
  const initial = await app.list(`--taskflow ${id}`);
  const before = readFileSync(initial.files.json);
  const beforeHtml = readFileSync(initial.files.html);
  limits = { maxRecords: 1 };
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "report_merge_limit",
    key: "maxRecords",
    value: 1,
    jsonCommitted: false,
  });
  expect(readFileSync(initial.files.json)).toEqual(before);
  expect(readFileSync(initial.files.html)).toEqual(beforeHtml);
  limits = { maxReportJsonMiB: 4 };
  for (let i = 0; i < 100; i++)
    manager.appendMessage({
      role: "user",
      content: `${i} ${"a".repeat(16300)}`,
      timestamp: Date.now(),
    });
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  const largeJson = readFileSync(initial.files.json);
  expect(largeJson.length).toBeGreaterThan(1048576);
  rmSync(manager.getSessionFile()!);
  limits = { maxFileMiB: 1, maxReportJsonMiB: 1 };
  const lower = await app.list(`--taskflow ${id}`);
  expect(lower).toMatchObject({
    errorCode: "report_read_limit",
    jsonCommitted: false,
  });
  expect(lower.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "maxReportJsonMiB", value: 1 }),
    ]),
  );
  expect(readFileSync(initial.files.json)).toEqual(largeJson);
  limits = { maxFileMiB: 1, maxReportJsonMiB: 4 };
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    jsonCommitted: true,
    htmlUpdated: true,
  });
});

test("taskflow-evaluate requires all output paths Git ignored and refuses tracked reports without changing Git state", async () => {
  const { cwd, sessionDir } = workspace();
  expect(spawnSync("git", ["init", cwd]).status).toBe(0);
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Git safety" }),
  );
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "report_git_not_private",
    jsonCommitted: false,
  });
  writeFileSync(join(cwd, ".gitignore"), ".pi/taskflow-reports/\n");
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  expect(
    spawnSync("git", ["-C", cwd, "add", "-f", first.files.json]).status,
  ).toBe(0);
  const index = readFileSync(join(cwd, ".git", "index"));
  const ignored = readFileSync(join(cwd, ".gitignore"));
  expect(await app.list(`--taskflow ${id}`)).toMatchObject({
    errorCode: "report_git_not_private",
    jsonCommitted: false,
  });
  expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
  expect(readFileSync(join(cwd, ".gitignore"))).toEqual(ignored);
});

test("taskflow-evaluate retains conflicting saved link values without guessing new ownership", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Immutable link",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  const file = manager.getSessionFile()!;
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      '"displayName":"Immutable link"',
      '"displayName":"Altered immutable link"',
    ),
  );
  const conflicting = await app.list(`--taskflow ${id}`);
  expect(conflicting).toMatchObject({ jsonCommitted: true, htmlUpdated: true });
  const report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.conflicts).toEqual(
    expect.arrayContaining([
      expect.stringContaining("immutable_source_conflict"),
    ]),
  );
  expect(report.roots[0].quarantine).toContain("registration_conflict");
  const replan = savedSession(cwd, sessionDir);
  expect(
    await runtime(replan).link({
      operation: "begin_planning",
      displayName: "Do not guess",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
});

test.each(["text", "json"])(
  "public Pi CLI %s collects Root JSON/HTML with complete receipt and unchanged sources",
  async (mode) => {
    const cwd = realpathSync(workspace().cwd);
    const sessionDir = join(cwd, "sessions");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }),
    );
    const manager = savedSession(cwd, sessionDir);
    const id = resultTaskflowId(
      await runtime(manager).link({
        operation: "begin_planning",
        displayName: "CLI reporting",
      }),
    );
    const source = readFileSync(manager.getSessionFile()!);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    };
    for (const key of Object.keys(env))
      if (
        key.endsWith("_API_KEY") ||
        /^(ANTHROPIC|OPENAI|GOOGLE|AZURE|GEMINI|COPILOT|GITHUB)_/.test(key)
      )
        delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        resolve(
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "--offline",
        "--no-extensions",
        "-e",
        resolve("src/index.ts"),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-mcp",
        "--session-dir",
        sessionDir,
        "--print",
        "--mode",
        mode,
        `/taskflow-evaluate --taskflow ${id}`,
      ],
      { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stderr).not.toMatch(
      /TASKFLOW_EVALUATION_RESULT|command error|Error in command|EPIPE/i,
    );
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("TASKFLOW_EVALUATION_RESULT "));
    expect(lines).toHaveLength(1);
    const receipt = JSON.parse(
      lines[0].slice("TASKFLOW_EVALUATION_RESULT ".length),
    );
    expect(receipt).toMatchObject({
      status: "updated",
      taskflowId: id,
      jsonCommitted: true,
      htmlUpdated: true,
    });
    expect(
      JSON.parse(readFileSync(receipt.files.json, "utf8")).contentDigest,
    ).toBe(receipt.contentDigest);
    expect(readFileSync(receipt.files.html, "utf8")).toContain(
      receipt.contentDigest,
    );
    expect(readFileSync(manager.getSessionFile()!)).toEqual(source);
    expect(result.stdout).not.toContain('"type":"message_start"');
  },
);

test.each([
  "derived",
  "multiple_roots",
  "parent_jump",
  "leaf",
  "duplicate",
  "missing_parent",
] as const)(
  "taskflow-evaluate reports %s navigation without adopting invalid identity",
  async (kind) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const app = runtime(manager);
    const id = resultTaskflowId(
      await app.link({
        operation: "begin_planning",
        displayName: "Tree boundary",
      }),
    );
    const first = await app.list(`--taskflow ${id}`);
    const oldJson = readFileSync(first.files.json);
    const oldHtml = readFileSync(first.files.html);
    const file = manager.getSessionFile()!;
    const entries = manager.getEntries();
    if (kind === "derived") {
      const lines = readFileSync(file, "utf8").split("\n");
      const header = JSON.parse(lines[0]);
      header.parentSession = join(sessionDir, "parent.jsonl");
      lines[0] = JSON.stringify(header);
      writeFileSync(file, lines.join("\n"));
    } else if (kind === "leaf") manager.branch(entries[0].id);
    else
      appendFileSync(
        file,
        `${JSON.stringify({ type: "message", id: kind === "duplicate" ? entries[0].id : `extra-${kind}`, parentId: kind === "multiple_roots" ? null : kind === "missing_parent" ? "nonexistent" : entries[0].id, timestamp: new Date().toISOString(), message: { role: "user", timestamp: Date.now(), content: "New branch" } })}\n`,
      );
    const receipt = await app.list(`--taskflow ${id}`);
    if (kind === "duplicate" || kind === "missing_parent") {
      expect(receipt).toMatchObject({
        errorCode: "discovery_incomplete",
        jsonCommitted: false,
        htmlUpdated: false,
      });
      expect(receipt.detectedQuarantine).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: manager.getSessionId(),
            reasons: ["invalid_entry_chain"],
          }),
        ]),
      );
      expect(readFileSync(first.files.json)).toEqual(oldJson);
      expect(readFileSync(first.files.html)).toEqual(oldHtml);
    } else {
      expect(receipt.jsonCommitted).toBe(true);
      const report = JSON.parse(readFileSync(first.files.json, "utf8"));
      expect(report.roots[0].quarantine).toContain(
        kind === "derived"
          ? "derived_session"
          : kind === "leaf"
            ? "current_leaf_mismatch"
            : "recorded_tree_navigation",
      );
    }
  },
);

test.each(["maxReportJsonMiB", "maxReportHtmlMiB"] as const)(
  "taskflow-evaluate %s output overflow leaves both old files untouched",
  async (key) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    let limits: Record<string, number> = {};
    const app = runtime(manager, {
      settings: () => ({ "taskflow-evaluation": { limits } }),
    });
    const id = resultTaskflowId(
      await app.link({
        operation: "begin_planning",
        displayName: "Output overflow",
      }),
    );
    const first = await app.list(`--taskflow ${id}`);
    const json = readFileSync(first.files.json),
      page = readFileSync(first.files.html);
    for (let i = 0; i < 100; i++)
      manager.appendMessage({
        role: "user",
        content: "x".repeat(16300),
        timestamp: Date.now(),
      });
    limits = { [key]: 1 };
    const failed = await app.list(`--taskflow ${id}`);
    expect(failed).toMatchObject({
      errorCode: "report_merge_limit",
      key,
      value: 1,
      jsonCommitted: false,
      htmlUpdated: false,
    });
    expect(failed.resume).toContain(`/reload`);
    expect(failed.unreflected).toContain("not committed");
    expect(readFileSync(first.files.json)).toEqual(json);
    expect(readFileSync(first.files.html)).toEqual(page);
  },
);

test.each([
  "tool_value",
  "report_field",
  "link_origin",
  "legacy_link",
  "source_file",
  "usage",
] as const)(
  "taskflow-evaluate validates saved %s evidence before using membership",
  async (kind) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const app = runtime(manager);
    const id = resultTaskflowId(
      await app.link({
        operation: "begin_planning",
        displayName: "Saved schema",
      }),
    );
    await app.link({ operation: "add_issues", issues: [issue1] });
    const first = await app.list(`--taskflow ${id}`);
    const report = JSON.parse(readFileSync(first.files.json, "utf8"));
    const observation = report.observations.find(
      (o: { kind: string }) =>
        o.kind ===
        (kind === "link_origin" || kind === "legacy_link" ? "link" : "request"),
    );
    if (kind === "tool_value") {
      observation.kind = "tool_call";
      observation.value = true;
      observation.provenance.field = "message.content.0";
    }
    if (kind === "report_field") {
      observation.kind = "report";
      observation.value = "Spoofed report";
      observation.provenance.field = "message.details.password";
    }
    if (kind === "link_origin")
      observation.value.originSessionId = "other-session";
    if (kind === "legacy_link") {
      delete observation.value.taskflowId;
      observation.value.unresolved = "source_issues_unresolved";
      observation.value.sourceIssues = [
        {
          kind: "github",
          host: "github.com",
          owner: "example",
          repo: "project",
          number: 1,
        },
      ];
    }
    if (kind === "source_file")
      observation.provenance.file = join(cwd, "outside.jsonl");
    if (kind === "usage") {
      observation.kind = "usage";
      observation.value = { input: -1 };
      observation.provenance.field = "message.usage.root_assistant";
    }
    observation.key = JSON.stringify([
      "session",
      observation.provenance.sessionId,
      observation.provenance.entryId,
      observation.provenance.field,
    ]);
    observation.sourceDigest = createHash("sha256")
      .update(JSON.stringify(observation.value))
      .digest("hex");
    const { contentDigest: _digest, ...data } = report;
    report.contentDigest = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    const corrupted = JSON.stringify(report);
    writeFileSync(first.files.json, corrupted);
    expect(await app.list(`--taskflow ${id}`)).toMatchObject({
      status: "not_updated",
      jsonCommitted: false,
      htmlUpdated: false,
      errorCode: expect.stringMatching(/^invalid_report_/),
    });
    expect(readFileSync(first.files.json, "utf8")).toBe(corrupted);
    const replan = savedSession(cwd, sessionDir);
    expect(
      await runtime(replan).link({
        operation: "begin_planning",
        displayName: "No invalid saved proof",
        sourceIssues: [issue1],
      }),
    ).toMatchObject({
      status: "rejected",
      errorCode: "planning_source_issues_unresolved",
    });
  },
);

test("taskflow-evaluate preserves structured Review and approval Tool results as raw observations", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Review observations",
    }),
  );
  const file = manager.getSessionFile()!;
  const beforeEntries = manager.getEntries();
  let parentId = beforeEntries.at(-1)!.id;
  for (const [index, toolName] of [
    "taskflow_plan_review",
    "taskflow_code_review",
  ].entries()) {
    const entryId = `review-result-${index}`;
    appendFileSync(
      file,
      `${JSON.stringify({ type: "message", id: entryId, parentId, timestamp: new Date().toISOString(), message: { role: "toolResult", toolName, toolCallId: `review-call-${index}`, isError: false, timestamp: Date.now(), content: [{ type: "text", text: "Review result recorded" }], details: { status: "approved", approved: true, findings: [{ severity: "info", text: "Checked <script>payload</script>" }], data: { reviewer: "public Tool observation" }, token: "REVIEW SECRET", thinking: "REVIEW THINKING", signature: "REVIEW SIGNATURE", image: { type: "image", data: "REVIEW BASE64" } } } })}\n`,
    );
    parentId = entryId;
  }
  const source = readFileSync(file);
  const receipt = await app.list(`--taskflow ${id}`);
  expect(receipt).toMatchObject({ jsonCommitted: true, htmlUpdated: true });
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  for (const index of [0, 1])
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_result",
          provenance: expect.objectContaining({
            entryId: `review-result-${index}`,
            field: "message.details",
          }),
          value: expect.objectContaining({
            status: "approved",
            approved: true,
            findings: [
              { severity: "info", text: "Checked <script>payload</script>" },
            ],
            data: { reviewer: "public Tool observation" },
          }),
        }),
      ]),
    );
  expect(
    report.observations.filter(
      (observation: { kind: string }) => observation.kind === "exit",
    ),
  ).toEqual([]);
  const json = readFileSync(receipt.files.json, "utf8");
  for (const secret of [
    "REVIEW SECRET",
    "REVIEW THINKING",
    "REVIEW SIGNATURE",
    "REVIEW BASE64",
  ])
    expect(json).not.toContain(secret);
  expect(readFileSync(receipt.files.html, "utf8")).toContain(
    "&lt;script&gt;payload&lt;/script&gt;",
  );
  expect(readFileSync(file)).toEqual(source);
});

test("taskflow-evaluate JSON and HTML connect Planning and each Issue to its Root runs and individual missing records", async () => {
  const { cwd, sessionDir } = workspace();
  const planning = savedSession(cwd, sessionDir);
  const app = runtime(planning);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Issue navigation",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1, issue2] });
  const implementations = [
    savedSession(cwd, sessionDir),
    savedSession(cwd, sessionDir),
  ];
  await Promise.all(
    implementations.map((manager) =>
      runtime(manager).link({ operation: "implementation", issue: issue1 }),
    ),
  );
  const receipt = await app.list(issue1);
  expect(receipt).toMatchObject({ taskflowId: id, jsonCommitted: true });
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  expect(report.planningSessionIds).toEqual([planning.getSessionId()]);
  expect(report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        issue: expect.objectContaining({ number: 1 }),
        implementationSessionIds: expect.arrayContaining(
          implementations.map((manager) => manager.getSessionId()),
        ),
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ number: 2 }),
        implementationSessionIds: [],
      }),
    ]),
  );
  const page = readFileSync(receipt.files.html, "utf8");
  for (const manager of implementations) {
    const rootIndex = report.roots.findIndex(
      (root: { sessionId: string }) =>
        root.sessionId === manager.getSessionId(),
    );
    expect(
      page.slice(page.indexOf('id="issue-0"'), page.indexOf('id="issue-1"')),
    ).toContain(`href="#root-${rootIndex}"`);
  }
  expect(
    page.slice(page.indexOf('id="issue-1"'), page.indexOf('id="roots"')),
  ).toContain("実行記録が見つからない");
});

test("taskflow-evaluate keeps valid links when Tool details are unsupported and redacts prefixed token keys", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Details boundary",
    }),
  );
  let parentId = manager.getEntries().at(-1)!.id;
  let deep: unknown = "DEEP_JSON_PAYLOAD_NOT_ACQUIRED";
  for (let index = 0; index < 35; index++) deep = { nested: deep };
  for (const [index, details] of [
    deep,
    {
      githubToken: "PREFIXED TOKEN SECRET",
      access_token: "ACCESS TOKEN SECRET",
      status: "reported",
      totalTokens: 12,
    },
  ].entries()) {
    const entryId = `details-${index}`;
    appendFileSync(
      manager.getSessionFile()!,
      `${JSON.stringify({ type: "message", id: entryId, parentId, timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "taskflow_code_review", toolCallId: entryId, timestamp: Date.now(), isError: false, content: [{ type: "text", text: "Raw result" }], details } })}\n`,
    );
    parentId = entryId;
  }
  const receipt = await app.list(`--taskflow ${id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const json = readFileSync(receipt.files.json, "utf8");
  expect(json).not.toContain("PREFIXED TOKEN SECRET");
  expect(json).not.toContain("ACCESS TOKEN SECRET");
  expect(json).not.toContain("DEEP_JSON_PAYLOAD_NOT_ACQUIRED");
  expect(json).toContain("unsupported_evidence:details-0:message.details");
  expect(json).toContain('"totalTokens": 12');
});

test("taskflow-evaluate unsupported deeply nested ToolCall evidence preserves valid explicit membership", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Deep call evidence",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  let args: unknown = "DEEP_ARGUMENT_NOT_ACQUIRED";
  for (let index = 0; index < 32; index++) args = { nested: args };
  const file = manager.getSessionFile()!;
  appendFileSync(
    file,
    `${JSON.stringify({ type: "message", id: "deep-tool-call", parentId: manager.getEntries().at(-1)!.id, timestamp: new Date().toISOString(), message: { role: "assistant", timestamp: Date.now(), content: [{ type: "toolCall", id: "deep-call", name: "review", arguments: args }] } })}\n`,
  );
  const before = readFileSync(file);
  const listing = await app.list();
  expect(listing).toMatchObject({
    complete: true,
    candidates: [expect.objectContaining({ taskflowId: id })],
  });
  expect(listing.sourceWarnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        warnings: expect.arrayContaining([
          "unsupported_evidence:deep-tool-call:message.content.0",
        ]),
      }),
    ]),
  );
  const replan = savedSession(cwd, sessionDir);
  expect(
    await runtime(replan).link({
      operation: "begin_planning",
      displayName: "Known ownership",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({ status: "saved", taskflowId: id });
  const receipt = await app.list(`--taskflow ${id}`);
  expect(receipt).toMatchObject({ jsonCommitted: true, htmlUpdated: true });
  expect(readFileSync(receipt.files.json, "utf8")).not.toContain(
    "DEEP_ARGUMENT_NOT_ACQUIRED",
  );
  expect(readFileSync(file)).toEqual(before);
});

test.each(["lower", "raise"] as const)(
  "taskflow-evaluate %s excerpt limit retains the most complete immutable evidence after source loss",
  async (change) => {
    const { cwd, sessionDir } = workspace();
    const manager = savedSession(cwd, sessionDir);
    const text = "e".repeat(5000);
    manager.appendMessage({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });
    let limits = change === "raise" ? { maxExcerptKiB: 1 } : {};
    const app = runtime(manager, {
      settings: () => ({ "taskflow-evaluation": { limits } }),
    });
    const id = resultTaskflowId(
      await app.link({
        operation: "begin_planning",
        displayName: "Excerpt preservation",
      }),
    );
    const first = await app.list(`--taskflow ${id}`);
    const initial = JSON.parse(readFileSync(first.files.json, "utf8"));
    const evidence = initial.observations.find(
      (o: { value: unknown }) =>
        typeof o.value === "string" && o.value.startsWith("eeee"),
    );
    expect(evidence.value.length).toBe(change === "raise" ? 1024 : 5000);
    limits = { maxExcerptKiB: change === "raise" ? 8 : 1 };
    expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
    let report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(
      report.observations.find((o: { key: string }) => o.key === evidence.key),
    ).toMatchObject({
      value: text,
      sourceDigest: evidence.sourceDigest,
      shortened: false,
    });
    rmSync(manager.getSessionFile()!);
    expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
    report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(
      report.observations.find((o: { key: string }) => o.key === evidence.key)
        .value,
    ).toBe(text);
  },
);

test("taskflow-evaluate saved begin conflicts cannot erase one owner and make another unique", async () => {
  const { cwd, sessionDir } = workspace();
  const first = savedSession(cwd, sessionDir);
  const app = runtime(first);
  const a = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Owner A" }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  expect((await app.list(`--taskflow ${a}`)).jsonCommitted).toBe(true);
  const second = runtime(savedSession(cwd, sessionDir));
  const b = resultTaskflowId(
    await second.link({ operation: "begin_planning", displayName: "Owner B" }),
  );
  await second.link({ operation: "add_issues", issues: [issue1] });
  const unrelated = runtime(savedSession(cwd, sessionDir));
  const c = resultTaskflowId(
    await unrelated.link({
      operation: "begin_planning",
      displayName: "Unrelated",
    }),
  );
  await unrelated.link({ operation: "add_issues", issues: [issue2] });
  writeFileSync(
    first.getSessionFile()!,
    readFileSync(first.getSessionFile()!, "utf8").replace(
      '"displayName":"Owner A"',
      '"displayName":"Changed Owner A"',
    ),
  );
  const listing = await app.list();
  expect(listing.complete).toBe(true);
  expect(listing.conflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskflowIds: expect.arrayContaining([a, b]) }),
    ]),
  );
  expect(await app.list(issue1)).toMatchObject({
    status: "not_updated",
    errorCode: "target_not_unique",
    jsonCommitted: false,
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "No guess",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "Known other Issue",
      sourceIssues: [issue2],
    }),
  ).toMatchObject({ status: "saved", taskflowId: c });
});

test("taskflow-evaluate latest report follows source assistant entry order rather than conflict insertion order", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Latest source report",
    }),
  );
  const assistant = {
    role: "assistant" as const,
    api: "anthropic-messages" as const,
    provider: "test",
    model: "fixture",
    stopReason: "stop" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const earlier = manager.appendMessage({
    ...assistant,
    content: [{ type: "text", text: "E1 earlier report" }],
    timestamp: Date.now() + 1000,
  });
  const latest = manager.appendMessage({
    ...assistant,
    content: [{ type: "text", text: "E2 latest report" }],
    timestamp: Date.now(),
  });
  const first = await app.list(`--taskflow ${id}`);
  const initial = JSON.parse(readFileSync(first.files.json, "utf8"));
  const latestKey = initial.observations.find(
    (o: { provenance: { entryId: string }; kind: string }) =>
      o.kind === "report" && o.provenance.entryId === latest,
  ).key;
  writeFileSync(
    manager.getSessionFile()!,
    readFileSync(manager.getSessionFile()!, "utf8").replace(
      "E1 earlier report",
      "E1 modified report",
    ),
  );
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.roots[0].latestReportKey).toBe(latestKey);
  expect(
    report.observations
      .filter(
        (o: { kind: string; provenance: { entryId: string } }) =>
          o.kind === "report" && o.provenance.entryId === earlier,
      )
      .map((o: { value: string }) => o.value),
  ).toEqual(["E1 earlier report", "E1 modified report"]);
  expect(report.conflicts).toEqual(
    expect.arrayContaining([expect.stringContaining(earlier)]),
  );
  rmSync(manager.getSessionFile()!);
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.roots[0].latestReportKey).toBe(latestKey);
});

test("taskflow-evaluate records public SDK context_edit content and null with raw provenance without tree quarantine", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const target = manager.getEntries()[0].id;
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Context edits",
    }),
  );
  const stringEdit = manager.appendContextEdit(target, {
    content: "Edited string",
  });
  const blocksEdit = manager.appendContextEdit(target, {
    content: [
      { type: "text", text: "Edited block", textSignature: "EDIT SIGNATURE" },
      { type: "image", data: "EDIT IMAGE", mimeType: "image/png" },
    ],
  });
  const nullEdit = manager.appendContextEdit(target, null);
  const source = readFileSync(manager.getSessionFile()!);
  const first = await app.list(`--taskflow ${id}`);
  expect(first.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.roots[0].quarantine).toEqual([]);
  for (const [entryId, field, value] of [
    [stringEdit, "replacement.content", "Edited string"],
    [blocksEdit, "replacement.content.0.text", "Edited block"],
    [nullEdit, "replacement", null],
  ]) {
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "context_edit",
          provenance: expect.objectContaining({ entryId, field }),
          value,
        }),
      ]),
    );
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "context_edit",
          provenance: expect.objectContaining({ entryId, field: "targetId" }),
          value: target,
        }),
      ]),
    );
  }
  const json = readFileSync(first.files.json, "utf8");
  expect(json).not.toContain("EDIT SIGNATURE");
  expect(json).not.toContain("EDIT IMAGE");
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  expect(readFileSync(manager.getSessionFile()!)).toEqual(source);
});

test("taskflow-evaluate includes related cross-Taskflow Issue ownership conflicts in JSON and HTML", async () => {
  const { cwd, sessionDir } = workspace();
  const app = runtime(savedSession(cwd, sessionDir));
  const a = resultTaskflowId(
    await app.link({ operation: "begin_planning", displayName: "Conflict A" }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  const other = runtime(savedSession(cwd, sessionDir));
  const b = resultTaskflowId(
    await other.link({
      operation: "begin_planning",
      displayName: "Conflict B",
    }),
  );
  await other.link({ operation: "add_issues", issues: [issue1] });
  const listing = await app.list();
  expect(listing.conflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskflowIds: expect.arrayContaining([a, b]) }),
    ]),
  );
  const receipt = await app.list(`--taskflow ${a}`);
  expect(receipt.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  expect(report.conflicts).toEqual(
    expect.arrayContaining([
      expect.stringContaining("explicit_issue_ownership_conflict"),
    ]),
  );
  expect(report.conflicts.join(" ")).toContain(b);
  expect(report.conflicts.join(" ")).toContain('"number":1');
  const page = readFileSync(receipt.files.html, "utf8");
  expect(page).toContain("explicit_issue_ownership_conflict");
  expect(page).toContain(b);
});

test("taskflow-evaluate conflicting add_issues evidence affects only its concrete Issue references", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Scoped evidence conflict",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  await app.link({ operation: "add_issues", issues: [issue2] });
  expect((await app.list(`--taskflow ${id}`)).jsonCommitted).toBe(true);
  writeFileSync(
    manager.getSessionFile()!,
    readFileSync(manager.getSessionFile()!, "utf8").replace(
      '"number":1',
      '"number":3',
    ),
  );
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "Conflicted Issue",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "Unaffected Issue",
      sourceIssues: [issue2],
    }),
  ).toMatchObject({ status: "saved", taskflowId: id });
});

test("taskflow-evaluate same-entry add_issues to identical begin variant cannot uniquely reuse its Issue", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Cross-operation proof",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  await app.link({ operation: "add_issues", issues: [issue2] });
  const first = await app.list(`--taskflow ${id}`);
  const oldJson = readFileSync(first.files.json);
  const oldHtml = readFileSync(first.files.html);
  const file = manager.getSessionFile()!;
  const entries = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const begin = entries.find(
    (entry) =>
      entry.type === "custom" && entry.data.operation === "begin_planning",
  );
  const addition = entries.find(
    (entry) => entry.type === "custom" && entry.data.operation === "add_issues",
  );
  addition.data = begin.data;
  writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const source = readFileSync(file);
  expect((await app.list()).complete).toBe(true);
  expect(await app.list(issue1)).toMatchObject({
    status: "not_updated",
    errorCode: "target_not_unique",
    jsonCommitted: false,
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "No changed operation reuse",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "Independent Issue proof",
      sourceIssues: [issue2],
    }),
  ).toMatchObject({ status: "saved", taskflowId: id });
  expect(readFileSync(first.files.json)).toEqual(oldJson);
  expect(readFileSync(first.files.html)).toEqual(oldHtml);
  expect(readFileSync(file)).toEqual(source);
});

test("taskflow-evaluate current legacy begin variant cannot remove saved valid ownership or promote legacy refs", async () => {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const a = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Saved explicit A",
    }),
  );
  await app.link({ operation: "add_issues", issues: [issue1] });
  const first = await app.list(`--taskflow ${a}`);
  const oldJson = readFileSync(first.files.json);
  const oldHtml = readFileSync(first.files.html);
  const other = runtime(savedSession(cwd, sessionDir));
  const b = resultTaskflowId(
    await other.link({
      operation: "begin_planning",
      displayName: "Independent B",
    }),
  );
  await other.link({ operation: "add_issues", issues: [issue1] });
  const unrelated = runtime(savedSession(cwd, sessionDir));
  const c = resultTaskflowId(
    await unrelated.link({
      operation: "begin_planning",
      displayName: "Known unrelated C",
    }),
  );
  await unrelated.link({ operation: "add_issues", issues: [issue2] });
  const file = manager.getSessionFile()!;
  const entries = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const begin = entries.find(
    (entry) =>
      entry.type === "custom" && entry.data.operation === "begin_planning",
  );
  delete begin.data.taskflowId;
  begin.data.unresolved = "source_issues_unresolved";
  begin.data.sourceIssues = [1, 2].map((number) => ({
    kind: "github",
    host: "github.com",
    owner: "example",
    repo: "project",
    number,
  }));
  writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const source = readFileSync(file);
  const listing = await app.list();
  expect(listing.complete).toBe(true);
  expect(listing.conflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskflowIds: expect.arrayContaining([a, b]) }),
    ]),
  );
  expect(await app.list(issue1)).toMatchObject({
    status: "not_updated",
    errorCode: "target_not_unique",
    jsonCommitted: false,
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "No legacy variant reuse",
      sourceIssues: [issue1],
    }),
  ).toMatchObject({
    status: "rejected",
    errorCode: "planning_source_issues_unresolved",
  });
  expect(
    await runtime(savedSession(cwd, sessionDir)).link({
      operation: "begin_planning",
      displayName: "Legacy ref is not membership",
      sourceIssues: [issue2],
    }),
  ).toMatchObject({ status: "saved", taskflowId: c });
  expect(readFileSync(first.files.json)).toEqual(oldJson);
  expect(readFileSync(first.files.html)).toEqual(oldHtml);
  expect(readFileSync(file)).toEqual(source);
});

// pi-subagents 0.77.0 foreground Details / SingleResult public contract.
async function foregroundChildFixture() {
  const { cwd, sessionDir } = workspace();
  const manager = savedSession(cwd, sessionDir);
  const app = runtime(manager);
  const id = resultTaskflowId(
    await app.link({
      operation: "begin_planning",
      displayName: "Direct review",
    }),
  );
  const runId = randomUUID();
  const childId = randomUUID();
  const rootFile = manager.getSessionFile()!;
  const childFile = join(
    rootFile.slice(0, -6),
    runId,
    "run-0",
    "session.jsonl",
  );
  const metadataPath = join(
    sessionDir,
    "subagent-artifacts",
    `${runId}_reviewer_0_meta.json`,
  );
  mkdirSync(join(childFile, ".."), { recursive: true });
  mkdirSync(join(metadataPath, ".."), { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(
    metadataPath,
    JSON.stringify({
      runId,
      agent: "reviewer",
      parentSessionId: manager.getSessionId(),
      task: "Review implementation",
      exitCode: 1,
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.1,
        turns: 1,
      },
    }),
  );
  writeFileSync(
    childFile,
    [
      {
        type: "session",
        version: 3,
        id: childId,
        cwd,
        timestamp,
        parentSession: rootFile,
      },
      {
        type: "message",
        id: "child-request",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: "Review implementation",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "child-report",
        parentId: "child-request",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "BLOCKED\nReview finding <script>bad()</script> password=private-value",
            },
          ],
          timestamp: Date.now(),
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "review-call",
    toolName: "subagent",
    isError: false,
    content: [{ type: "text", text: "Public review result" }],
    timestamp: Date.now(),
    details: {
      runId,
      results: [
        {
          index: 0,
          agent: "reviewer",
          task: "Review implementation",
          exitCode: 1,
          sessionFile: childFile,
          artifactPaths: { metadataPath },
          finalOutput: "Review result",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.1,
            turns: 1,
          },
        },
      ],
    },
  });
  return {
    cwd,
    sessionDir,
    manager,
    app,
    id,
    runId,
    childId,
    childFile,
    metadataPath,
    rootFile,
  };
}

test("taskflow-evaluate acquires foreground direct-child review with typed parent proof and provenance, then deduplicates saved evidence", async () => {
  const f = await foregroundChildFixture();
  const before = readFileSync(f.childFile);
  const receipt = await f.app.list(`--taskflow ${f.id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  expect(report.children).toEqual([
    expect.objectContaining({
      rootSessionId: f.manager.getSessionId(),
      runId: f.runId,
      index: 0,
      sessionId: f.childId,
      parentProof: "confirmed",
      availability: "available",
    }),
  ]);
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "report",
        value:
          "BLOCKED\nReview finding <script>bad()</script> password=[REDACTED]",
        provenance: expect.objectContaining({
          source: "session",
          sessionId: f.childId,
          rootSessionId: f.manager.getSessionId(),
          runId: f.runId,
        }),
      }),
      expect.objectContaining({
        kind: "usage",
        value: expect.objectContaining({ cost: 0.1, turns: 1 }),
      }),
    ]),
  );
  const page = readFileSync(receipt.files.html, "utf8");
  expect(page).toContain("Direct children");
  expect(page).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(page).not.toContain("private-value");
  expect(page).toContain(receipt.contentDigest);
  expect(readFileSync(f.childFile)).toEqual(before);
  const again = await f.app.list(`--taskflow ${f.id}`);
  expect(again.jsonCommitted).toBe(true);
  expect(
    JSON.parse(readFileSync(receipt.files.json, "utf8")).observations,
  ).toHaveLength(report.observations.length);
});

test("taskflow-evaluate acquires background lifecycle/proof and versioned output archive; mutable status is not an immutable conflict", async () => {
  const f = await foregroundChildFixture();
  const temp = realpathSync(workspace().cwd);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
  try {
    const asyncDir = join(temp, "async-subagent-runs", f.runId);
    const resultsDir = join(temp, "async-subagent-results");
    const archivePath = join(resultsDir, "output-archives", `${f.runId}.json`);
    mkdirSync(asyncDir, { recursive: true });
    mkdirSync(join(archivePath, ".."), { recursive: true });
    const statusPath = join(asyncDir, "status.json");
    const status = {
      lifecycleArtifactVersion: 3,
      runId: f.runId,
      sessionId: f.rootFile,
      cwd: f.cwd,
      state: "running",
      steps: [
        { agent: "reviewer", status: "running", sessionFile: f.childFile },
      ],
    };
    writeFileSync(statusPath, JSON.stringify(status));
    writeFileSync(
      join(asyncDir, "process-terminal.json"),
      JSON.stringify({
        version: 1,
        runId: f.runId,
        state: "unknown",
        runnerProcessInstanceId: "process-1",
        reason: "observer-unavailable",
        resumeDisposition: "unavailable",
      }),
    );
    writeFileSync(
      archivePath,
      JSON.stringify({
        version: 1,
        runId: f.runId,
        createdAt: Date.now(),
        entries: [
          {
            agent: "reviewer",
            resultIndex: 0,
            source: "result-tail",
            text: "Archived Review result",
            truncated: true,
          },
        ],
      }),
    );
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "wait",
      toolName: "bg_wait",
      isError: false,
      content: [{ type: "text", text: "Wait completed" }],
      timestamp: Date.now(),
      details: {
        completions: [
          {
            runId: f.runId,
            agent: "reviewer",
            archivePath,
            results: [
              {
                agent: "reviewer",
                success: false,
                sessionFile: f.childFile,
                artifactPaths: { metadataPath: f.metadataPath },
              },
            ],
          },
        ],
      },
    });
    const first = await f.app.list(`--taskflow ${f.id}`);
    expect(first.jsonCommitted).toBe(true);
    let report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "report",
          value: "Archived Review result",
          provenance: expect.objectContaining({
            artifactKind: "archive",
            field: "entries.0.text",
          }),
        }),
        expect.objectContaining({
          kind: "lifecycle",
          value: "running",
          provenance: expect.objectContaining({
            artifactKind: "status",
            field: "state",
          }),
        }),
      ]),
    );
    expect(report.children[0].warnings).toContain("archive_output_truncated");
    writeFileSync(statusPath, JSON.stringify({ ...status, state: "complete" }));
    writeFileSync(
      join(asyncDir, "process-terminal.json"),
      JSON.stringify({
        version: 1,
        runId: f.runId,
        state: "observed",
        runnerProcessInstanceId: "process-1",
        observedAt: Date.now(),
        instances: [
          {
            kind: "runner",
            processInstanceId: "process-1",
            closeObservedAt: Date.now(),
            exitCode: 7,
            signal: null,
          },
        ],
        resumeDisposition: "resumable",
      }),
    );
    expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
    report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(
      report.observations
        .filter(
          (o: { provenance: { artifactKind?: string; field: string } }) =>
            o.provenance.artifactKind === "status" &&
            o.provenance.field === "state",
        )
        .map((o: { value: string }) => o.value),
    ).toEqual(["running", "complete"]);
    expect(
      report.conflicts.filter(
        (c: string) =>
          c.includes('"status"') || c.includes('"process-terminal"'),
      ),
    ).toEqual([]);
    expect(readFileSync(first.files.html, "utf8")).toContain(
      "process-terminal proof は成功を意味しません",
    );
    rmSync(f.childFile);
    rmSync(f.metadataPath);
    expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
    report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(report.children[0].availability).toBe("missing_or_unread");
    expect(
      report.observations.some(
        (o: { value: unknown }) => o.value === "Archived Review result",
      ),
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("taskflow-evaluate correlates reordered non-contiguous result indices with actual result and archive positions", async () => {
  const f = await foregroundChildFixture();
  const temp = realpathSync(workspace().cwd);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
  try {
    const archivePath = join(
      temp,
      "async-subagent-results",
      "output-archives",
      `${f.runId}.json`,
    );
    mkdirSync(join(archivePath, ".."), { recursive: true });
    const root = readFileSync(f.rootFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    root.at(-1).message.details = {
      runId: f.runId,
      archivePath,
      results: [
        { index: 7, agent: "reviewer", task: "Seven" },
        { index: 2, agent: "reviewer", task: "Two" },
      ],
    };
    writeFileSync(
      f.rootFile,
      root.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    writeFileSync(
      join(temp, "async-subagent-results", `${f.runId}.json`),
      JSON.stringify({
        id: f.runId,
        lifecycleArtifactVersion: 3,
        sessionId: f.rootFile,
        results: [
          { index: 2, agent: "reviewer", finalOutput: "RESULT TWO" },
          { index: 7, agent: "reviewer", finalOutput: "RESULT SEVEN" },
        ],
      }),
    );
    writeFileSync(
      archivePath,
      JSON.stringify({
        version: 1,
        runId: f.runId,
        createdAt: Date.now(),
        entries: [
          {
            resultIndex: 0,
            agent: "reviewer",
            source: "result-tail",
            text: "ARCHIVE TWO",
          },
          {
            resultIndex: 1,
            agent: "reviewer",
            source: "result-tail",
            text: "ARCHIVE SEVEN",
          },
        ],
      }),
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "RESULT TWO",
          provenance: expect.objectContaining({
            artifactKind: "result",
            index: 2,
            field: "results.0.finalOutput",
          }),
        }),
        expect.objectContaining({
          value: "RESULT SEVEN",
          provenance: expect.objectContaining({
            artifactKind: "result",
            index: 7,
            field: "results.1.finalOutput",
          }),
        }),
        expect.objectContaining({
          value: "ARCHIVE TWO",
          provenance: expect.objectContaining({
            artifactKind: "archive",
            index: 2,
            field: "entries.0.text",
          }),
        }),
        expect.objectContaining({
          value: "ARCHIVE SEVEN",
          provenance: expect.objectContaining({
            artifactKind: "archive",
            index: 7,
            field: "entries.1.text",
          }),
        }),
      ]),
    );
    expect(
      report.observations.filter(
        (o: { provenance: { artifactKind?: string; index?: number } }) =>
          o.provenance.artifactKind === "archive" && o.provenance.index === 7,
      ),
    ).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("taskflow-evaluate rejects explicit result index mismatch instead of positional fallback", async () => {
  const f = await foregroundChildFixture();
  const temp = realpathSync(workspace().cwd);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
  try {
    const archivePath = join(
      temp,
      "async-subagent-results",
      "output-archives",
      `${f.runId}.json`,
    );
    mkdirSync(join(archivePath, ".."), { recursive: true });
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "wait",
      toolName: "bg_wait",
      isError: false,
      timestamp: Date.now(),
      content: [],
      details: {
        completions: [
          { runId: f.runId, results: [{ agent: "reviewer" }], archivePath },
        ],
      },
    });
    writeFileSync(
      join(temp, "async-subagent-results", `${f.runId}.json`),
      JSON.stringify({
        id: f.runId,
        sessionId: f.rootFile,
        results: [
          { index: 9, agent: "reviewer", finalOutput: "WRONG CHILD RESULT" },
        ],
      }),
    );
    writeFileSync(
      archivePath,
      JSON.stringify({
        version: 1,
        runId: f.runId,
        createdAt: Date.now(),
        entries: [
          {
            resultIndex: 0,
            agent: "reviewer",
            source: "result-tail",
            text: "WRONG CHILD ARCHIVE",
          },
        ],
      }),
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(
      report.observations.filter(
        (o: { provenance: { artifactKind?: string } }) =>
          ["result", "archive"].includes(o.provenance.artifactKind ?? ""),
      ),
    ).toEqual([]);
    expect(report.children[0].warnings).toContain(
      "child_result_attribution_unknown",
    );
    expect(report.children[0].warnings).toContain(
      "archive_child_attribution_unknown",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("taskflow-evaluate cannot use wrapper run ID as missing per-child result identity", async () => {
  const f = await foregroundChildFixture();
  const temp = realpathSync(workspace().cwd);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
  try {
    const archivePath = join(
      temp,
      "async-subagent-results",
      "output-archives",
      `${f.runId}.json`,
    );
    mkdirSync(join(archivePath, ".."), { recursive: true });
    const root = readFileSync(f.rootFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    root.at(-1).message.details = {
      runId: f.runId,
      archivePath,
      results: [
        { index: 0, agent: "reviewer" },
        { index: 1, agent: "reviewer" },
      ],
    };
    writeFileSync(
      f.rootFile,
      root.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    writeFileSync(
      join(temp, "async-subagent-results", `${f.runId}.json`),
      JSON.stringify({
        id: f.runId,
        sessionId: f.rootFile,
        results: [
          {
            runId: f.runId,
            agent: "reviewer",
            finalOutput: "AMBIGUOUS WRAPPER RESULT",
          },
        ],
      }),
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(
      report.observations.filter(
        (o: { provenance: { artifactKind?: string } }) =>
          o.provenance.artifactKind === "result",
      ),
    ).toEqual([]);
    expect(
      report.children.every((child: { warnings: string[] }) =>
        child.warnings.includes("child_result_attribution_unknown"),
      ),
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test.each(["replay", "unknown"])(
  "taskflow-evaluate %s archive mapping does not confuse same-agent children with stable indices",
  async (mapping) => {
    const f = await foregroundChildFixture();
    const temp = realpathSync(workspace().cwd);
    vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
    try {
      const firstRun = randomUUID();
      const secondRun = randomUUID();
      const archivePath = join(
        temp,
        "async-subagent-results",
        "output-archives",
        `${f.runId}.json`,
      );
      mkdirSync(join(archivePath, ".."), { recursive: true });
      const root = readFileSync(f.rootFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      root.at(-1).message.details = {
        runId: f.runId,
        archivePath,
        results: [
          { index: 7, runId: firstRun, agent: "reviewer" },
          { index: 2, runId: secondRun, agent: "reviewer" },
        ],
      };
      writeFileSync(
        f.rootFile,
        root.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      if (mapping === "replay") {
        const replayPath = join(
          temp,
          "async-subagent-results",
          "completion-replay",
          `${f.runId}.json`,
        );
        mkdirSync(join(replayPath, ".."), { recursive: true });
        writeFileSync(
          replayPath,
          JSON.stringify({
            version: 1,
            runId: f.runId,
            sessionId: f.rootFile,
            completedAt: Date.now(),
            expiresAt: Date.now() + 60000,
            archivePath,
            completion: {
              runId: f.runId,
              results: [
                { runId: secondRun, agent: "reviewer", success: false },
                { runId: firstRun, agent: "reviewer", success: true },
              ],
            },
          }),
        );
      }
      writeFileSync(
        archivePath,
        JSON.stringify({
          version: 1,
          runId: f.runId,
          createdAt: Date.now(),
          entries: [
            {
              resultIndex: 0,
              agent: "reviewer",
              source: "result-tail",
              text: "SECOND CHILD ARCHIVE",
            },
            {
              resultIndex: 1,
              agent: "reviewer",
              source: "result-tail",
              text: "FIRST CHILD ARCHIVE",
            },
          ],
        }),
      );
      const receipt = await f.app.list(`--taskflow ${f.id}`);
      expect(receipt.jsonCommitted).toBe(true);
      const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
      const archived = report.observations.filter(
        (o: { provenance: { artifactKind?: string } }) =>
          o.provenance.artifactKind === "archive",
      );
      if (mapping === "replay")
        expect(archived).toEqual([
          expect.objectContaining({
            value: "FIRST CHILD ARCHIVE",
            provenance: expect.objectContaining({
              index: 7,
              runId: firstRun,
              field: "entries.1.text",
            }),
          }),
          expect.objectContaining({
            value: "SECOND CHILD ARCHIVE",
            provenance: expect.objectContaining({
              index: 2,
              runId: secondRun,
              field: "entries.0.text",
            }),
          }),
        ]);
      else {
        expect(archived).toEqual([]);
        expect(
          report.children.every((child: { warnings: string[] }) =>
            child.warnings.includes("archive_child_attribution_unknown"),
          ),
        ).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("taskflow-evaluate accepts the producer's run-level archive without resultIndex when completion has no child rows", async () => {
  const f = await foregroundChildFixture();
  const temp = realpathSync(workspace().cwd);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
  try {
    const wrapper = randomUUID();
    const archivePath = join(
      temp,
      "async-subagent-results",
      "output-archives",
      `${wrapper}.json`,
    );
    mkdirSync(join(archivePath, ".."), { recursive: true });
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "wait",
      toolName: "bg_wait",
      isError: false,
      timestamp: Date.now(),
      content: [],
      details: { completions: [{ runId: wrapper, archivePath }] },
    });
    writeFileSync(
      archivePath,
      JSON.stringify({
        version: 1,
        runId: wrapper,
        createdAt: Date.now(),
        entries: [{ source: "result-tail", text: "RUN LEVEL SUMMARY" }],
      }),
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "RUN LEVEL SUMMARY",
          provenance: expect.objectContaining({
            runId: wrapper,
            artifactKind: "archive",
            field: "entries.0.text",
          }),
        }),
      ]),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test.each([
  "missing",
  "id-as-path",
  "path-as-id",
  "conflicting-id",
  "conflicting-path",
])(
  "taskflow-evaluate %s parent evidence never promotes child body but retains explicit Root membership and public result",
  async (mode) => {
    const f = await foregroundChildFixture();
    const metadata = JSON.parse(readFileSync(f.metadataPath, "utf8"));
    const lines = readFileSync(f.childFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (mode === "missing") {
      delete metadata.parentSessionId;
      delete lines[0].parentSession;
    }
    if (mode === "id-as-path") {
      delete metadata.parentSessionId;
      lines[0].parentSession = f.manager.getSessionId();
    }
    if (mode === "path-as-id") {
      metadata.parentSessionId = f.rootFile;
      delete lines[0].parentSession;
    }
    if (mode === "conflicting-id") metadata.parentSessionId = randomUUID();
    if (mode === "conflicting-path")
      lines[0].parentSession = join(f.sessionDir, "other.jsonl");
    writeFileSync(f.metadataPath, JSON.stringify(metadata));
    writeFileSync(
      f.childFile,
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.planningSessionIds).toEqual([f.manager.getSessionId()]);
    expect(report.children[0].parentProof).toBe(
      mode === "missing" ? "unconfirmed" : "conflict",
    );
    expect(
      report.observations.some(
        (o: { provenance: { rootSessionId?: string; source: string } }) =>
          o.provenance.rootSessionId && o.provenance.source === "session",
      ),
    ).toBe(false);
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "report", value: "Review result" }),
      ]),
    );
  },
);

test("taskflow-evaluate excludes fork inherited prefix and marks unprovable fork attribution without normal body", async () => {
  const f = await foregroundChildFixture();
  const child = readFileSync(f.childFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const parent = readFileSync(f.rootFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  child[1].parentId = parent.at(-1).id;
  writeFileSync(
    f.childFile,
    [child[0], ...parent.slice(1), ...child.slice(1)]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const first = await f.app.list(`--taskflow ${f.id}`);
  expect(first.jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].warnings).toContain(
    "fork_inherited_prefix_excluded",
  );
  expect(
    report.observations
      .filter(
        (o: {
          provenance: { rootSessionId?: string; source: string };
          kind: string;
        }) =>
          o.provenance.rootSessionId &&
          o.provenance.source === "session" &&
          o.kind === "request",
      )
      .map((o: { value: string }) => o.value),
  ).toEqual(["Review implementation"]);
  // An inherited entry after child-owned content cannot be attributed as a prefix.
  const inherited = { ...parent[1], parentId: child.at(-1).id };
  child[1].parentId = null;
  writeFileSync(
    f.childFile,
    [...child, inherited].map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].warnings).toContain(
    "fork_child_attribution_unknown",
  );
});

test.each([
  ["child_tree_navigation", "shortened"],
  ["child_tree_navigation", "root-missing"],
  ["fork_child_attribution_unknown", "shortened"],
  ["fork_child_attribution_unknown", "root-missing"],
])(
  "taskflow-evaluate preserves detected %s after %s without reopening saved child body",
  async (warning, unavailable) => {
    const f = await foregroundChildFixture();
    const initial = readFileSync(f.childFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const first = await f.app.list(`--taskflow ${f.id}`);
    expect(first.jsonCommitted).toBe(true);
    const bodySummary =
      "report / session / child session / child-report / message.content.0.text";
    expect(readFileSync(first.files.html, "utf8")).toContain(
      `<details open><summary>${bodySummary}`,
    );
    const rootEntries = readFileSync(f.rootFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const added =
      warning === "child_tree_navigation"
        ? {
            type: "branch_summary",
            id: "branch",
            parentId: "child-report",
            timestamp: new Date().toISOString(),
            summary: "Different branch",
          }
        : { ...rootEntries[1], parentId: "child-report" };
    writeFileSync(
      f.childFile,
      [...initial, added].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
    expect(
      JSON.parse(readFileSync(first.files.json, "utf8")).children[0].warnings,
    ).toContain(warning);
    if (unavailable === "shortened")
      writeFileSync(
        f.childFile,
        initial
          .slice(0, 2)
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
    else rmSync(f.rootFile);
    expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(first.files.json, "utf8"));
    expect(report.children[0].warnings).toContain(warning);
    expect(report.children[0].availability).toBe(
      unavailable === "shortened" ? "shortened" : "missing_or_unread",
    );
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({ entryId: "child-report" }),
        }),
      ]),
    );
    const page = readFileSync(first.files.html, "utf8");
    expect(page).toContain(`<details><summary>${bodySummary}`);
    expect(page).not.toContain(`<details open><summary>${bodySummary}`);
  },
);

test("taskflow-evaluate workflow wrapper and child run IDs remain distinct through custom subagent-notify public references", async () => {
  const f = await foregroundChildFixture();
  const wrapper = randomUUID();
  f.manager.appendCustomMessageEntry(
    "subagent-notify",
    "Workflow stopped",
    true,
    {
      runs: [
        {
          runId: wrapper,
          workflowRunId: wrapper,
          status: "stopped",
          childRuns: [
            {
              runId: f.runId,
              workflowKey: "review",
              agent: "reviewer",
              status: "failed",
            },
          ],
        },
      ],
    },
  );
  const receipt = await f.app.list(`--taskflow ${f.id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  expect(report.children).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: f.runId, wrapperRunId: wrapper }),
    ]),
  );
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "lifecycle",
        value: "failed",
        provenance: expect.objectContaining({ artifactKind: "public-result" }),
      }),
    ]),
  );
});

test.each([
  "missing",
  "empty",
  "line-limit",
  "unfinished-header",
  "unsupported-fields",
])(
  "taskflow-evaluate uses public transcript v1 and managed output with %s session evidence, not replay/system payloads",
  async (mode) => {
    const f = await foregroundChildFixture();
    if (mode === "line-limit")
      appendFileSync(
        f.childFile,
        JSON.stringify({
          type: "message",
          id: "oversize",
          parentId: "child-report",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            timestamp: Date.now(),
            content: "x".repeat(1048577),
          },
        }) + "\n",
      );
    else if (mode === "empty") writeFileSync(f.childFile, "");
    else if (mode === "unfinished-header")
      writeFileSync(
        f.childFile,
        readFileSync(f.childFile, "utf8").split("\n")[0],
      );
    else rmSync(f.childFile);
    const transcriptPath = f.metadataPath.replace(
      "_meta.json",
      "_transcript.jsonl",
    );
    const outputPath = f.metadataPath.replace("_meta.json", "_output.md");
    const metadata = JSON.parse(readFileSync(f.metadataPath, "utf8"));
    metadata.transcriptPath = transcriptPath;
    if (mode === "unsupported-fields") metadata.unusedField = { version: 999 };
    writeFileSync(f.metadataPath, JSON.stringify(metadata));
    writeFileSync(outputPath, "Managed output Review finding");
    writeFileSync(
      transcriptPath,
      [
        {
          version: 1,
          recordType: "message",
          runId: f.runId,
          agent: "reviewer",
          childIndex: 0,
          cwd: f.cwd,
          timestamp: new Date().toISOString(),
          sourceEventType: "message_end",
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [
              { type: "text", text: "Transcript Review finding" },
              { type: "thinking", thinking: "PRIVATE REPLAY" },
            ],
          },
        },
        {
          version: 1,
          recordType: "message",
          runId: f.runId,
          agent: "reviewer",
          childIndex: 0,
          cwd: f.cwd,
          timestamp: new Date().toISOString(),
          message: { role: "system", content: "PRIVATE SYSTEM" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const app =
      mode === "line-limit"
        ? runtime(f.manager, {
            settings: () => ({
              "taskflow-evaluation": { limits: { maxLineMiB: 1 } },
            }),
          })
        : f.app;
    const receipt = await app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "report",
          value: "Transcript Review finding",
          provenance: expect.objectContaining({
            artifactKind: "transcript",
            field: "line.0.message.content.0.text",
          }),
        }),
        expect.objectContaining({
          kind: "report",
          value: "Managed output Review finding",
          provenance: expect.objectContaining({ artifactKind: "output" }),
        }),
      ]),
    );
    expect(readFileSync(receipt.files.json, "utf8")).not.toMatch(
      /PRIVATE REPLAY|PRIVATE SYSTEM/,
    );
  },
);

test.each([
  "conflicting-header-duplicate-id",
  "conflicting-header-invalid-link",
  "metadata-schema",
  "metadata-parent-type",
  "metadata-identity",
  "metadata-version",
  "header-parent-type",
  "header-version",
])(
  "taskflow-evaluate invalid parent identity %s cannot fall back to managed child body",
  async (mode) => {
    const f = await foregroundChildFixture();
    const child = readFileSync(f.childFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const metadata = JSON.parse(readFileSync(f.metadataPath, "utf8"));
    const transcriptPath = f.metadataPath.replace(
      "_meta.json",
      "_transcript.jsonl",
    );
    const outputPath = f.metadataPath.replace("_meta.json", "_output.md");
    metadata.transcriptPath = transcriptPath;
    writeFileSync(outputPath, "INVALID FALLBACK OUTPUT");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        version: 1,
        recordType: "message",
        runId: f.runId,
        agent: "reviewer",
        childIndex: 0,
        cwd: f.cwd,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "INVALID FALLBACK TRANSCRIPT" }],
        },
      }) + "\n",
    );
    if (mode.startsWith("conflicting-header")) {
      child[0].parentSession = join(f.sessionDir, "other-root.jsonl");
      if (mode.endsWith("duplicate-id")) child[2].id = child[1].id;
      else
        child.push({
          type: "custom",
          id: "bad-link",
          parentId: "child-report",
          timestamp: new Date().toISOString(),
          customType: "pi-taskflow-evaluation.link",
          data: { version: 99 },
        });
    }
    if (mode === "metadata-parent-type") metadata.parentSessionId = 42;
    if (mode === "metadata-identity") metadata.runId = randomUUID();
    if (mode === "metadata-version") metadata.version = 99;
    if (mode === "header-parent-type") child[0].parentSession = 42;
    if (mode === "header-version") child[0].version = 99;
    writeFileSync(
      f.metadataPath,
      JSON.stringify(mode === "metadata-schema" ? [] : metadata),
    );
    writeFileSync(
      f.childFile,
      child.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.planningSessionIds).toEqual([f.manager.getSessionId()]);
    expect(report.children[0].parentProof).not.toBe("confirmed");
    if (mode.startsWith("conflicting-header"))
      expect(report.children[0].parentProof).toBe("conflict");
    expect(
      report.observations.filter(
        (o: {
          provenance: {
            rootSessionId?: string;
            source: string;
            artifactKind?: string;
          };
        }) =>
          o.provenance.rootSessionId &&
          (o.provenance.source === "session" ||
            ["output", "transcript", "metadata"].includes(
              o.provenance.artifactKind ?? "",
            )),
      ),
    ).toEqual([]);
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "report", value: "Review result" }),
      ]),
    );
  },
);

test("taskflow-evaluate refuses saved child artifact provenance with unknown kind even when digests are internally consistent", async () => {
  const f = await foregroundChildFixture();
  const first = await f.app.list(`--taskflow ${f.id}`);
  const report = JSON.parse(readFileSync(first.files.json, "utf8"));
  const observation = report.observations.find(
    (o: { provenance: { artifactKind?: string } }) =>
      o.provenance.artifactKind === "metadata",
  );
  observation.provenance.artifactKind = "arbitrary-file";
  const key = JSON.parse(observation.key);
  key[5] = "arbitrary-file";
  observation.key = JSON.stringify(key);
  const { contentDigest: _digest, ...data } = report;
  report.contentDigest = createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
  writeFileSync(first.files.json, JSON.stringify(report));
  const receipt = await f.app.list(`--taskflow ${f.id}`);
  expect(receipt).toMatchObject({
    jsonCommitted: false,
    errorCode: "invalid_report_provenance",
  });
});

test.each([
  "arbitrary",
  "traversal",
  "symlink",
  "metadata-version",
  "metadata-identity",
  "child-header-version",
  "unsupported-body",
  "nested-parent",
])(
  "taskflow-evaluate %s child input is bounded or unsupported without losing explicit membership",
  async (mode) => {
    const f = await foregroundChildFixture();
    const root = readFileSync(f.rootFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = root.at(-1).message.details.results[0];
    const child = readFileSync(f.childFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const metadata = JSON.parse(readFileSync(f.metadataPath, "utf8"));
    const outside = join(f.cwd, "unmanaged.jsonl");
    if (["arbitrary", "traversal", "symlink"].includes(mode)) {
      writeFileSync(
        outside,
        JSON.stringify({ ...child[0], parentSession: f.rootFile }) +
          "\n" +
          JSON.stringify({
            ...child[1],
            message: {
              role: "user",
              timestamp: Date.now(),
              content: "DO NOT ACQUIRE OUTSIDE BODY",
            },
          }) +
          "\n",
      );
      if (mode === "arbitrary") result.sessionFile = outside;
      if (mode === "traversal")
        result.sessionFile = f.childFile.replace("/run-0/", "/run-0/../run-0/");
      if (mode === "symlink") {
        rmSync(f.childFile);
        symlinkSync(outside, f.childFile);
      }
    }
    if (mode === "metadata-version") metadata.version = 99;
    if (mode === "metadata-identity") metadata.runId = randomUUID();
    if (mode === "child-header-version") child[0].version = 99;
    if (mode === "unsupported-body") {
      child[2].message.content = [{ type: "text", text: 42 }];
      child[2].message.usage = { input: "bad" };
    }
    if (mode === "nested-parent") {
      metadata.parentSessionId = randomUUID();
      child[0].parentSession = join(
        f.rootFile.slice(0, -6),
        "parent-child",
        "session.jsonl",
      );
    }
    if (mode !== "symlink")
      writeFileSync(
        f.childFile,
        child.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    writeFileSync(f.metadataPath, JSON.stringify(metadata));
    writeFileSync(
      f.rootFile,
      root.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const originalRoot = readFileSync(f.rootFile);
    const receipt = await f.app.list(`--taskflow ${f.id}`);
    expect(receipt.jsonCommitted).toBe(true);
    const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
    expect(report.planningSessionIds).toEqual([f.manager.getSessionId()]);
    expect(readFileSync(f.rootFile)).toEqual(originalRoot);
    expect(readFileSync(receipt.files.json, "utf8")).not.toContain(
      "DO NOT ACQUIRE OUTSIDE BODY",
    );
    expect(report.children[0].warnings.length).toBeGreaterThan(0);
    if (["metadata-version", "metadata-identity"].includes(mode))
      expect(
        report.observations.some(
          (o: { provenance: { artifactKind?: string } }) =>
            o.provenance.artifactKind === "metadata",
        ),
      ).toBe(false);
    if (
      [
        "arbitrary",
        "traversal",
        "symlink",
        "child-header-version",
        "nested-parent",
      ].includes(mode)
    )
      expect(
        report.observations.some(
          (o: { provenance: { rootSessionId?: string; source: string } }) =>
            o.provenance.rootSessionId && o.provenance.source === "session",
        ),
      ).toBe(false);
    if (mode === "unsupported-body")
      expect(
        report.observations.some(
          (o: {
            kind: string;
            provenance: { rootSessionId?: string; source: string };
          }) =>
            o.provenance.rootSessionId &&
            o.provenance.source === "session" &&
            ["report", "usage"].includes(o.kind),
        ),
      ).toBe(false);
  },
);

test("taskflow-evaluate child session immutable edits conflict; shortening keeps old evidence and current availability separate", async () => {
  const f = await foregroundChildFixture();
  const first = await f.app.list(`--taskflow ${f.id}`);
  expect(first.jsonCommitted).toBe(true);
  const child = readFileSync(f.childFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  child[2].message.content = [
    { type: "text", text: "Changed immutable Review report" },
  ];
  writeFileSync(
    f.childFile,
    child.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(
    report.conflicts.some(
      (c: string) =>
        c.includes("immutable_source_conflict") && c.includes("child-report"),
    ),
  ).toBe(true);
  expect(
    report.observations.some(
      (o: { value: unknown }) => o.value === "Changed immutable Review report",
    ),
  ).toBe(true);
  writeFileSync(
    f.childFile,
    child
      .slice(0, 2)
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].availability).toBe("shortened");
  expect(
    report.observations.some(
      (o: { value: unknown }) => o.value === "Changed immutable Review report",
    ),
  ).toBe(true);
});

test("taskflow-evaluate enforces common child count/excerpt/record limits without discarding the old pair", async () => {
  const f = await foregroundChildFixture();
  let limits: Record<string, number> = {
    maxChildrenPerRoot: 1,
    maxExcerptKiB: 1,
  };
  const app = runtime(f.manager, {
    settings: () => ({ "taskflow-evaluation": { limits } }),
  });
  const child = readFileSync(f.childFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  child[2].message.content[0].text = "x".repeat(3000);
  writeFileSync(
    f.childFile,
    child.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "second",
    toolName: "subagent",
    isError: false,
    content: [{ type: "text", text: "Second child" }],
    timestamp: Date.now(),
    details: {
      runId: randomUUID(),
      results: [{ index: 0, agent: "reviewer", task: "Second review" }],
    },
  });
  const first = await app.list(`--taskflow ${f.id}`);
  expect(first.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children).toHaveLength(1);
  expect(report.roots[0].warnings.join(";")).toContain(
    "child_limit:maxChildrenPerRoot=1",
  );
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "report",
        value: "x".repeat(1024),
        shortened: true,
      }),
    ]),
  );
  const json = readFileSync(first.files.json),
    page = readFileSync(first.files.html);
  limits = { maxRecords: 1 };
  expect((await app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(false);
  expect(readFileSync(first.files.json)).toEqual(json);
  expect(readFileSync(first.files.html)).toEqual(page);
});

test("taskflow-evaluate reads a child's initial byte boundary while later append is deferred until manual recollection", async () => {
  const f = await foregroundChildFixture();
  let childFd: number | undefined;
  let appended = false;
  const originalOpen = fs.openSync,
    originalRead = fs.readSync;
  const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = originalOpen(...args);
    if (String(args[0]) === realpathSync(f.childFile)) childFd = fd;
    return fd;
  });
  const read = vi
    .spyOn(fs, "readSync")
    .mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (args[0] === childFd && !appended) {
        appended = true;
        appendFileSync(
          f.childFile,
          JSON.stringify({
            type: "message",
            id: "later-child",
            parentId: "child-report",
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              timestamp: Date.now(),
              content: "Deferred child request",
            },
          }) + "\n",
        );
      }
      return count;
    });
  syncBuiltinESMExports();
  let first;
  try {
    first = await f.app.list(`--taskflow ${f.id}`);
  } finally {
    open.mockRestore();
    read.mockRestore();
    syncBuiltinESMExports();
  }
  expect(first.jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].warnings).toContain(
    "child_appended_after_boundary",
  );
  expect(
    report.observations.some(
      (o: { value: unknown }) => o.value === "Deferred child request",
    ),
  ).toBe(false);
  expect((await f.app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(
    report.observations.some(
      (o: { value: unknown }) => o.value === "Deferred child request",
    ),
  ).toBe(true);
});

test("taskflow-evaluate retains valid W2 schemaVersion 1 Root proof without requiring new child fields", async () => {
  const f = await foregroundChildFixture();
  const first = await f.app.list(`--taskflow ${f.id}`);
  const report = JSON.parse(readFileSync(first.files.json, "utf8"));
  delete report.children;
  report.observations = report.observations.filter(
    (o: { provenance: { rootSessionId?: string } }) =>
      !o.provenance.rootSessionId,
  );
  const { contentDigest: _digest, ...data } = report;
  report.contentDigest = createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
  writeFileSync(first.files.json, JSON.stringify(report));
  rmSync(f.rootFile);
  const receipt = await f.app.list(`--taskflow ${f.id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const collected = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(collected.planningSessionIds).toEqual([f.manager.getSessionId()]);
  expect(collected.roots[0].availability).toBe("missing_or_unread");
  expect(collected.children).toEqual([]);
});

test.each([
  "status-version",
  "proof-version",
  "archive-version",
  "archive-identity",
  "expired-replay",
  "old-temp-root",
])(
  "taskflow-evaluate %s public artifact is not replaced with success or zero Usage",
  async (mode) => {
    const f = await foregroundChildFixture();
    const temp = realpathSync(workspace().cwd);
    vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", temp);
    try {
      const asyncDir = join(temp, "async-subagent-runs", f.runId);
      const resultsDir = join(temp, "async-subagent-results");
      const archivePath = join(
        resultsDir,
        "output-archives",
        `${f.runId}.json`,
      );
      mkdirSync(asyncDir, { recursive: true });
      mkdirSync(join(archivePath, ".."), { recursive: true });
      mkdirSync(join(resultsDir, "completion-replay"));
      writeFileSync(
        join(asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: mode === "status-version" ? 99 : 3,
          runId: f.runId,
          sessionId: f.rootFile,
          cwd: f.cwd,
          state: "failed",
        }),
      );
      writeFileSync(
        join(asyncDir, "process-terminal.json"),
        JSON.stringify({
          version: mode === "proof-version" ? 99 : 1,
          runId: f.runId,
          state: "unknown",
          runnerProcessInstanceId: "runner-1",
          reason: "observer-unavailable",
        }),
      );
      writeFileSync(
        archivePath,
        JSON.stringify({
          version: mode === "archive-version" ? 99 : 1,
          runId: mode === "archive-identity" ? randomUUID() : f.runId,
          createdAt: Date.now(),
          entries: [
            {
              resultIndex: 0,
              agent: "reviewer",
              source: "result-tail",
              text: "Archive-only result",
            },
          ],
        }),
      );
      writeFileSync(
        join(resultsDir, "completion-replay", `${f.runId}.json`),
        JSON.stringify({
          version: 1,
          runId: f.runId,
          sessionId: f.rootFile,
          completedAt: Date.now() - 1000,
          expiresAt: Date.now() - 1,
          completion: { runId: f.runId, state: "complete", success: true },
          archivePath,
        }),
      );
      f.manager.appendMessage({
        role: "toolResult",
        toolCallId: "async",
        toolName: "subagent",
        isError: false,
        content: [{ type: "text", text: "Running" }],
        timestamp: Date.now(),
        details: {
          asyncId: f.runId,
          agent: "reviewer",
          asyncDir:
            mode === "old-temp-root"
              ? join(f.cwd, "old-root", "async-subagent-runs", f.runId)
              : asyncDir,
          archivePath,
        },
      });
      const receipt = await f.app.list(`--taskflow ${f.id}`);
      expect(receipt.jsonCommitted).toBe(true);
      const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
      expect(report.children[0].warnings.length).toBeGreaterThan(0);
      const kinds = report.observations.filter(
        (o: { provenance: { artifactKind?: string } }) =>
          ["status", "process-terminal", "archive", "replay"].includes(
            o.provenance.artifactKind ?? "",
          ),
      );
      expect(
        kinds.some(
          (o: { value: unknown }) => o.value === true || o.value === 0,
        ),
      ).toBe(false);
      if (mode === "status-version")
        expect(
          kinds.some(
            (o: { provenance: { artifactKind: string } }) =>
              o.provenance.artifactKind === "status",
          ),
        ).toBe(false);
      if (mode === "proof-version")
        expect(
          kinds.some(
            (o: { provenance: { artifactKind: string } }) =>
              o.provenance.artifactKind === "process-terminal",
          ),
        ).toBe(false);
      if (mode.startsWith("archive-"))
        expect(
          kinds.some(
            (o: { provenance: { artifactKind: string } }) =>
              o.provenance.artifactKind === "archive",
          ),
        ).toBe(false);
      if (mode === "expired-replay")
        expect(report.children[0].warnings).toContain(
          "completion_replay_expired",
        );
      if (mode === "old-temp-root") expect(kinds).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("taskflow-evaluate shares artifact read budget and output limits with Root and saved evidence", async () => {
  const f = await foregroundChildFixture();
  let limits: Record<string, number> = {
    maxReadMiB: 1,
    maxFileMiB: 1,
    maxExcerptKiB: 1,
  };
  const app = runtime(f.manager, {
    settings: () => ({ "taskflow-evaluation": { limits } }),
  });
  const child = readFileSync(f.childFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  child[2].message.content[0].text = "b".repeat(600000);
  writeFileSync(
    f.childFile,
    child.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  writeFileSync(
    f.metadataPath.replace("_meta.json", "_output.md"),
    "c".repeat(600000),
  );
  const first = await app.list(`--taskflow ${f.id}`);
  expect(first.jsonCommitted).toBe(true);
  let report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].warnings.join(";")).toContain("maxReadMiB=1");
  expect(
    report.observations.some(
      (o: { provenance: { artifactKind?: string } }) =>
        o.provenance.artifactKind === "output",
    ),
  ).toBe(false);
  limits = { maxFileMiB: 1 };
  child[2].message.content[0].text = "b".repeat(1200000);
  writeFileSync(
    f.childFile,
    child.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  expect((await app.list(`--taskflow ${f.id}`)).jsonCommitted).toBe(true);
  report = JSON.parse(readFileSync(first.files.json, "utf8"));
  expect(report.children[0].warnings.join(";")).toContain("maxFileMiB=1");
  const json = readFileSync(first.files.json),
    page = readFileSync(first.files.html);
  limits = { maxReportJsonMiB: 1, maxExcerptKiB: 2048 };
  expect(await app.list(`--taskflow ${f.id}`)).toMatchObject({
    jsonCommitted: false,
    key: "maxReportJsonMiB",
  });
  expect(readFileSync(first.files.json)).toEqual(json);
  expect(readFileSync(first.files.html)).toEqual(page);
});

test("taskflow-evaluate public singleton and row evidence field paths name actual source fields, not inherited wrapper values", async () => {
  const f = await foregroundChildFixture();
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "launch",
    toolName: "subagent",
    isError: false,
    content: [{ type: "text", text: "Running" }],
    timestamp: Date.now(),
    details: { asyncId: f.runId, agent: "reviewer", state: "running" },
  });
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "workflow",
    toolName: "subagent",
    isError: false,
    content: [{ type: "text", text: "Workflow" }],
    timestamp: Date.now(),
    details: {
      runId: f.runId,
      state: "WRAPPER ONLY",
      results: [{ index: 0, agent: "reviewer", finalOutput: "Row result" }],
    },
  });
  const receipt = await f.app.list(`--taskflow ${f.id}`);
  expect(receipt.jsonCommitted).toBe(true);
  const report = JSON.parse(readFileSync(receipt.files.json, "utf8"));
  const publicEvidence = report.observations.filter(
    (o: { provenance: { artifactKind?: string } }) =>
      o.provenance.artifactKind === "public-result",
  );
  expect(publicEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "running",
        provenance: expect.objectContaining({ field: "message.details.state" }),
      }),
    ]),
  );
  expect(
    publicEvidence.some(
      (o: { value: unknown; provenance: { field: string } }) =>
        o.value === "WRAPPER ONLY" &&
        o.provenance.field === "message.details.results.0.state",
    ),
  ).toBe(false);
});
