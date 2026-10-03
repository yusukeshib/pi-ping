import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import ping, { parseInterval } from "../extensions/index.ts";

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const messages: unknown[] = [];
  const notices: string[] = [];
  const branch: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  let idle = true;
  let pending = false;
  let editor = "";
  let throwOnSend = false;
  let startOnSend = false;
  const ctx = {
    hasUI: true, mode: "tui", isIdle: () => idle,
    hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      getEditorText: () => editor,
    },
  } as unknown as ExtensionContext;
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, value: { handler: typeof command }) => { command = value.handler; },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: unknown, options: unknown) => {
      if (throwOnSend) throw new Error("offline");
      messages.push({ message, options });
      if (startOnSend) { idle = false; emit("agent_start"); }
    },
  } as unknown as ExtensionAPI;
  ping(pi);
  return {
    emit, ctx, messages, notices, branch, statuses,
    cmd: (args: string) => command(args, ctx),
    advance: (ms: number) => t.mock.timers.tick(ms),
    idle: (value: boolean) => { idle = value; },
    pending: (value: boolean) => { pending = value; },
    editor: (value: string) => { editor = value; },
    throwOnSend: (value: boolean) => { throwOnSend = value; },
    startOnSend: () => { startOnSend = true; },
  };
}

test("duration parsing and bounds", () => {
  for (const [value, ms] of [["5", 300000], ["5m", 300000], ["0.5m", 30000], ["1s", 1000], ["24h", 86400000], ["2H", 7200000]] as const) {
    assert.equal(parseInterval(value), ms);
  }
  for (const value of ["0", "-1", "NaN", "Infinity", "1ms", "0.1s", "25h", "5 m", "1e9", "1.0001s"]) {
    assert.equal(parseInterval(value), undefined, value);
  }
});

test("default off and enabling waits a full five minutes", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  h.advance(600000);
  assert.equal(h.messages.length, 0);
  await h.cmd("enable");
  h.advance(299999);
  assert.equal(h.messages.length, 0);
  h.advance(1);
  assert.equal(h.messages.length, 1);
  const sent = h.messages[0] as { message: { customType: string; content: string }; options: unknown };
  assert.equal(sent.message.customType, "pi-ping");
  assert.match(sent.message.content, /Do not invent new work/);
  assert.deepEqual(sent.options, { triggerTurn: true });
  assert.match(h.notices.at(-1)!, /Automatically starts model turns/);
});

test("one timer, interval changes, disable cancels immediately", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 1s");
  await h.cmd("enable 1s");
  await h.cmd("interval 2s");
  h.advance(1000);
  assert.equal(h.messages.length, 0);
  h.advance(1000);
  assert.equal(h.messages.length, 1);
  await h.cmd("disable");
  h.advance(10000);
  assert.equal(h.messages.length, 1);
  assert.equal(h.statuses.at(-1), undefined);
  await h.cmd("interval 1s");
  h.advance(1000);
  assert.equal(h.messages.length, 1);
});

test("agent_end is not idle: wait for settlement including failed network attempts", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 1s");
  h.idle(false);
  h.emit("agent_start");
  h.emit("agent_end");
  h.advance(60000);
  assert.equal(h.messages.length, 0);
  h.idle(true);
  h.emit("agent_settled");
  h.advance(999);
  assert.equal(h.messages.length, 0);
  h.advance(1);
  assert.equal(h.messages.length, 1);
});

test("guards busy state, pending messages, UI dialogs and editor draft", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 1s");
  h.idle(false); h.advance(1000);
  h.idle(true); h.pending(true); h.advance(1000);
  h.pending(false); h.editor("typing"); h.advance(1000);
  h.editor(""); h.emit("ui_prompt_start"); h.emit("ui_prompt_start"); h.advance(1000);
  h.emit("ui_prompt_end"); h.advance(1000);
  assert.equal(h.messages.length, 0);
  h.emit("ui_prompt_end"); h.advance(1000);
  assert.equal(h.messages.length, 1);
});

test("user input resets idle delay; an actual wake turn suspends future pings", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 2s");
  h.advance(1000); h.emit("input"); h.advance(1000);
  assert.equal(h.messages.length, 0);
  h.startOnSend(); h.advance(1000);
  assert.equal(h.messages.length, 1);
  h.advance(20000);
  assert.equal(h.messages.length, 1);
  h.idle(true); h.emit("agent_settled"); h.advance(2000);
  assert.equal(h.messages.length, 2);
});

test("send failure is reported and retried without accumulating queued messages", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 1s");
  h.throwOnSend(true); h.advance(1000);
  assert.match(h.notices.at(-1)!, /offline/);
  h.throwOnSend(false); h.advance(1000);
  assert.equal(h.messages.length, 1);
});

test("reload/resume restore branch state; new session and shutdown cannot leak timers", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 1s");
  h.emit("session_shutdown"); h.advance(1000);
  assert.equal(h.messages.length, 0);
  h.emit("session_start", { reason: "reload" }); h.advance(1000);
  assert.equal(h.messages.length, 1);
  await h.cmd("disable");
  h.emit("session_start", { reason: "resume" }); h.advance(1000);
  assert.equal(h.messages.length, 1);
  h.branch.length = 0;
  h.emit("session_start", { reason: "new" }); h.advance(1000);
  assert.equal(h.messages.length, 1);
  h.emit("session_shutdown"); h.emit("session_shutdown");
});

test("tree navigation and malformed persisted data", async (t) => {
  const h = harness(t);
  h.branch.push({ type: "custom", customType: "pi-ping-state", data: { enabled: true, intervalMs: 0 } });
  h.emit("session_start"); h.advance(300000);
  assert.equal(h.messages.length, 0);
  await h.cmd("enable 1s");
  h.branch.length = 0;
  h.emit("session_tree"); h.advance(1000);
  assert.equal(h.messages.length, 0);
});

test("status and invalid arguments don't mutate settings or reset deadline", async (t) => {
  const h = harness(t);
  h.emit("session_start");
  await h.cmd("enable 2s"); h.advance(1000);
  const entries = h.branch.length;
  for (const args of ["", "status", "wat", "interval", "enable 0", "disable 5m", "status 1s", "enable 1s extra"]) await h.cmd(args);
  assert.equal(h.branch.length, entries);
  h.advance(1000);
  assert.equal(h.messages.length, 1);
});
