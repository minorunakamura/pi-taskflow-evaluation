import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    const list = async () => {
      lines.length = 0;
      await session.prompt("/taskflow-evaluate --list");
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
