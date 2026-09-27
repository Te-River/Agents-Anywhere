#!/usr/bin/env node
/**
 * Live cross-process harness for the **real built** Bridge Hub.
 *
 * It loads the published plugin entry point (`lib/index.js`, produced by
 * `yarn build`) and calls `plugin.setup(stubCtx)` exactly the way the OpenCode
 * host does, so the Hub that listens on loopback and publishes its endpoint
 * file is the shipped artifact — not a test double.
 *
 * The stub ctx stands in for the pieces of OpenCode only the real host can
 * provide (`event.subscribe`, `permission.hook`, `permission.reply`,
 * `ctx.session.*`, `app.version`). Events are injected through the Hub's own
 * public `ingest()` — the very call `#consume(stream)` makes for each framed
 * event, so the projection / registry / sync tracker code under test is the
 * production path.
 *
 * The stub `ctx.session` methods synthesise the events the real host would emit
 * (create → session.created, prompt → session.next.prompted, interrupt →
 * session.execution.interrupted) and record every call; `permission.reply`
 * records the request and synthesises `permission.replied`. This is what lets
 * the Python Connector drive a complete remote round-trip over real TCP.
 *
 * Deliberately NOT `*.test.ts`: it is meaningless without the Python Connector
 * on the other end, so it must never be picked up by `yarn test`. It is driven
 * by `connector/tests/test_opencode_bridge_live_integration.py`.
 *
 * stdout protocol (one line each):
 *   HARNESS_READY <json>   endpoint published; JSON = {pid, port, endpointPath, locations}
 *   EVENT_OK <0|1>         result of the matching EVENT command
 *   CALLS <json>           recorded ctx.session.* calls
 *   REPLIES <json>         recorded ctx.permission.reply requests
 *   EVALUATE_RESULT <v>    return value of the installed evaluate hook
 *   PERMISSION_OK <0|1>    result of the matching PERMISSION command
 *   METRICS <json>         hub metrics
 *   HARNESS_ERROR <text>   fatal startup problem
 * stdin protocol (one command per line):
 *   EVENT <base64(json)>       ingest one OpenCode event envelope
 *   PERMISSION <base64(json)>  ingest a permission.asked event
 *   EVALUATE <base64(json)>    call the installed evaluate hook
 *   CALLS | REPLIES | METRICS  dump recorded state
 *   STOP                       shut the hub down and exit
 */
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libEntry = join(here, '..', '..', 'lib', 'index.js')

if (!existsSync(libEntry)) {
  console.log('HARNESS_ERROR lib/index.js is missing; run `yarn build` in opencode-plugin first')
  process.exit(3)
}

const LOCATION_A = process.env.AA_HARNESS_LOCATION_A
const LOCATION_B = process.env.AA_HARNESS_LOCATION_B
if (
  typeof LOCATION_A !== 'string' ||
  LOCATION_A.length === 0 ||
  typeof LOCATION_B !== 'string' ||
  LOCATION_B.length === 0
) {
  console.log('HARNESS_ERROR AA_HARNESS_LOCATION_A and AA_HARNESS_LOCATION_B are required')
  process.exit(3)
}

const { default: plugin } = await import(pathToFileURL(libEntry).href)
if (typeof plugin?.setup !== 'function') {
  console.log('HARNESS_ERROR the built plugin does not export a plugin with setup()')
  process.exit(3)
}

// A subscription that stays open and never yields: enough for install() to
// attach, while events come in through hub.ingest() deterministically.
const idleStream = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise(() => undefined) }
  },
}

let hub = null
const calls = []
const replies = []
const pendingPermissions = new Map()
let evaluate = null
let createdCount = 0
let sequence = 0

function ingest(type, sessionID, directory, data, durableSeq) {
  const envelope = {
    id: `${type}:${(sequence += 1)}`,
    created: '2026-09-27T00:00:00.000Z',
    type,
    location: { directory },
    data: { sessionID, ...(data || {}) },
  }
  if (durableSeq !== undefined) {
    envelope.durable = { aggregateID: sessionID, seq: durableSeq, version: 1 }
  }
  return hub.ingest(envelope) === true
}

/** A per-location stub ctx pushed through the plugin's own setup() entry point. */
function sessionContext(directory) {
  return {
    location: { directory },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream },
    session: {
      create: (options) => {
        createdCount += 1
        const id = `ses_created_${createdCount}`
        calls.push({ name: 'create', options })
        ingest('session.created', id, directory, { title: 'created' }, 1)
        return { id }
      },
      prompt: (options) => {
        calls.push({ name: 'prompt', options })
        ingest('session.next.prompted', options.sessionID, directory, { text: options.content ?? '' })
        return {}
      },
      interrupt: (options) => {
        calls.push({ name: 'interrupt', options })
        ingest('session.execution.interrupted', options.sessionID, directory, { reason: options.reason ?? 'user' })
        return {}
      },
      switchModel: (options) => {
        calls.push({ name: 'switchModel', options })
        return {}
      },
      switchAgent: (options) => {
        calls.push({ name: 'switchAgent', options })
        return {}
      },
    },
    permission: {
      hook: (name, callback) => {
        evaluate = callback
        return { dispose: () => undefined }
      },
      reply: (request) => {
        replies.push(request)
        const requestID = request?.path?.requestID
        const pending = pendingPermissions.get(requestID)
        if (pending) {
          ingest('permission.replied', pending.sessionID, pending.directory, { requestID, reply: request?.body?.reply ?? 'once' })
        }
        return {}
      },
    },
  }
}

try {
  await plugin.setup(sessionContext(LOCATION_A))
  await plugin.setup(sessionContext(LOCATION_B))
} catch (error) {
  console.log(`HARNESS_ERROR setup threw: ${error?.name ?? typeof error}`)
  process.exit(4)
}

hub = globalThis[Symbol.for('agents-anywhere.opencode.hub')]
if (hub === undefined || typeof hub.ingest !== 'function') {
  console.log('HARNESS_ERROR the hub was not installed on the global key')
  process.exit(4)
}

console.log(
  `HARNESS_READY ${JSON.stringify({
    pid: process.pid,
    port: hub.port,
    endpointPath: hub.endpointPath,
    locations: [LOCATION_A, LOCATION_B],
  })}`,
)

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const [command, payload] = trimmed.split(' ', 2)
  if (command === 'EVENT') {
    let accepted = false
    try {
      const event = JSON.parse(Buffer.from(payload ?? '', 'base64').toString('utf8'))
      accepted = hub.ingest(event) === true
    } catch {
      accepted = false
    }
    console.log(`EVENT_OK ${accepted ? 1 : 0}`)
    return
  }
  if (command === 'PERMISSION') {
    let accepted = false
    try {
      const spec = JSON.parse(Buffer.from(payload ?? '', 'base64').toString('utf8'))
      const directory = spec.directory || LOCATION_A
      pendingPermissions.set(spec.id, { sessionID: spec.sessionID, directory })
      accepted = ingest('permission.asked', spec.sessionID, directory, { id: spec.id, action: spec.action, resources: spec.resources ?? [] })
    } catch {
      accepted = false
    }
    console.log(`PERMISSION_OK ${accepted ? 1 : 0}`)
    return
  }
  if (command === 'EVALUATE') {
    let rendered = 'undefined'
    try {
      const input = JSON.parse(Buffer.from(payload ?? '', 'base64').toString('utf8'))
      const returned = typeof evaluate === 'function' ? evaluate(input) : undefined
      rendered = returned === undefined ? 'undefined' : JSON.stringify(returned)
    } catch {
      rendered = 'error'
    }
    console.log(`EVALUATE_RESULT ${rendered}`)
    return
  }
  if (command === 'CALLS') {
    console.log(`CALLS ${JSON.stringify(calls)}`)
    return
  }
  if (command === 'REPLIES') {
    console.log(`REPLIES ${JSON.stringify(replies)}`)
    return
  }
  if (command === 'METRICS') {
    console.log(`METRICS ${JSON.stringify(hub.metrics)}`)
    return
  }
  if (command === 'STOP') {
    rl.close()
    Promise.resolve(hub.stop()).finally(() => process.exit(0))
  }
})
