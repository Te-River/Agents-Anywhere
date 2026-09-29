import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import * as queue from "../src/components/session/message-queue.ts"

// Execute the actual send handler with its view and transport dependencies stubbed.
const detail = readFileSync(new URL("../src/components/session-detail.tsx", import.meta.url), "utf8")
const start = detail.indexOf("  const handleSend = async (")
const end = detail.indexOf("\n  React.useEffect(() => {", start)
const handler = ts.transpileModule(detail.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const interruptStart = detail.indexOf("  const handleInterrupt = async () => {")
const interruptEnd = detail.indexOf("\n  const handleSendQueuedNow =", interruptStart)
const interruptHandler = ts.transpileModule(detail.slice(interruptStart, interruptEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText

function fixture(sessionId, api) {
  queue.enqueueMessage(sessionId, { id: "old", content: "old", attachments: [], selections: {}, status: "queued" })
  queue.pauseMessageQueue(sessionId)
  let state = { session: { id: sessionId }, state: { status: "idle" }, items: [] }
  const failures = []
  const toasts = { errors: [], successes: [] }
  const context = {
    ...queue, sessionId, session: state.session, state,
    queuedMessages: queue.readMessageQueue(sessionId),
    sendInFlightRef: { current: false }, activeSessionIdRef: { current: sessionId },
    createClientId: () => "fresh", tNew: key => key, tSession: key => key,
    timelineFollowRef: { current: null }, eventSequenceCursor: { current: () => 0 },
    buildOptimisticUserMessage: () => ({ id: "fresh", source: {} }),
    addOptimisticMessage() {}, setSending() {}, interrupting: false, setInterrupting() {},
    setState: update => { state = update(state) },
    nextOptimisticRuntimeState: () => ({ status: "waiting" }),
    mergeTimelineItems: (current, incoming) => [...current, ...incoming],
    selectionPatchFromComposerSelections: (_current, selections) => selections,
    runtimeState: { selections: {} },
    runtimeStateWithSelectionResult: current => current,
    dashboardApi: api, token: "fixture",
    sessionSourceErrorCode: () => null,
    markOptimisticMessageFailed: (id, message) => { failures.push({ id, message }) },
    timelineClientMessageId: () => null,
    toast: { error: message => toasts.errors.push(message), success: message => toasts.successes.push(message) },
  }
  const handlers = new Function(...Object.keys(context), `${handler}\n${interruptHandler}\nreturn { send: handleSend, interrupt: handleInterrupt }`)(...Object.values(context))
  return { ...handlers, failures, toasts }
}

for (const failure of ["selection", "send"]) {
  test(`${failure} failure keeps old messages paused even after the view returns to idle`, async () => {
    const sessionId = `fresh-failed-${failure}`
    const { send } = fixture(sessionId, {
      updateSessionSelections: async () => { throw new Error("selection failed") },
      sendSessionMessage: async () => { throw new Error("send failed") },
    })
    assert.equal(await send("new instruction", [], failure === "selection" ? { model: "other" } : {}), false)
    assert.equal(queue.messageQueueIsPaused(sessionId), true)
    await queue.drainMessageQueue(sessionId, async () => assert.fail("failed fresh send must not release old messages"))
    assert.equal(queue.readMessageQueue(sessionId)[0].id, "old")
  })
}

test("old messages remain paused until the fresh send is accepted", async () => {
  const sessionId = "fresh-success"
  let accept
  const { send } = fixture(sessionId, {
    sendSessionMessage: () => new Promise(resolve => { accept = resolve }),
  })
  const pending = send("new instruction", [], {})
  assert.equal(queue.messageQueueIsPaused(sessionId), true)
  await queue.drainMessageQueue(sessionId, async () => assert.fail("pending send must not release the queue"))
  accept({ ok: true, result: {} })
  assert.equal(await pending, true)
  assert.equal(queue.messageQueueIsPaused(sessionId), false)
  await queue.drainMessageQueue(sessionId, async item => { assert.equal(item.id, "old"); return true })
})

test("a newer stop keeps an already-paused queue held after an earlier fresh send is accepted", async () => {
  const sessionId = "fresh-success-after-stop"
  let accept
  const { send, interrupt } = fixture(sessionId, {
    sendSessionMessage: () => new Promise(resolve => { accept = resolve }),
    interruptSession: async () => ({ ok: true, result: {} }),
  })
  const pending = send("new instruction", [], {})
  await interrupt()
  accept({ ok: true, result: {} })
  assert.equal(await pending, true)
  assert.equal(queue.messageQueueIsPaused(sessionId), true)
  await queue.drainMessageQueue(sessionId, async () => assert.fail("a late send acknowledgment must not undo the newer stop"))
  assert.equal(queue.readMessageQueue(sessionId)[0].id, "old")
})

test("stopping another session does not prevent an accepted fresh send from resuming its own queue", async () => {
  const sessionId = "fresh-success-other-stop"
  let accept
  const { send } = fixture(sessionId, {
    sendSessionMessage: () => new Promise(resolve => { accept = resolve }),
  })
  const { interrupt } = fixture("other-session-stop", {
    interruptSession: async () => ({ ok: true, result: {} }),
  })
  const pending = send("new instruction", [], {})
  await interrupt()
  accept({ ok: true, result: {} })
  assert.equal(await pending, true)
  assert.equal(queue.messageQueueIsPaused(sessionId), false)
  assert.equal(queue.messageQueueIsPaused("other-session-stop"), true)
})

for (const [name, result] of [
  ["runtime rejection without a steered flag", { ok: false, code: "codex_no_active_turn", message: "No active turn to steer" }],
  ["an explicit negative steered flag", { ok: true, steered: false }],
]) {
  test(`steering fails for ${name} even when the transport succeeds`, async () => {
    const sessionId = `steer-failed-${name}`
    const { send, failures, toasts } = fixture(sessionId, {
      steerSessionMessage: async () => ({ ok: true, result }),
    })
    assert.equal(await send("steering instruction", [], {}, "steer"), false)
    assert.deepEqual(failures, [{ id: "fresh", message: "steerFailed" }])
    assert.deepEqual(toasts.errors, ["steerFailed"])
    assert.deepEqual(toasts.successes, [])
    assert.equal(queue.messageQueueIsPaused(sessionId), true)
  })
}

test("accepted steering succeeds without resuming an already-paused queue", async () => {
  const sessionId = "steer-success"
  const { send, failures, toasts } = fixture(sessionId, {
    steerSessionMessage: async () => ({ ok: true, result: { ok: true, steered: true } }),
  })
  assert.equal(await send("steering instruction", [], {}, "steer"), true)
  assert.deepEqual(failures, [])
  assert.deepEqual(toasts.errors, [])
  assert.deepEqual(toasts.successes, ["steered"])
  assert.equal(queue.messageQueueIsPaused(sessionId), true)
})
