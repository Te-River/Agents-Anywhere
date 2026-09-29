import assert from "node:assert/strict"
import test from "node:test"

import {
  dshAgentPresetLabel,
  dshAgentPresetOptions,
  dshNewSessionAgentPreset,
} from "../src/features/dashboard/dsh-agent-presets.ts"

const runtime = {
  runtimeType: "dsh",
  config: { defaultAgentPreset: "minimal" },
  defaults: { defaultAgentPreset: "standard" },
  uiSchema: {
    defaultAgentPreset: {
      component: "select",
      options: [
        { value: "standard", label: "Standard" },
        { value: "minimal", label: "Minimal", description: "Only essential tools" },
        { value: "custom", label: "代码审查", description: "Review code" },
        { value: "broken", label: "Broken", disabled: true, disabledReason: "Missing plugin" },
        { label: "Invalid entry" },
      ],
    },
  },
}
const options = dshAgentPresetOptions(runtime)
const translate = (key) => ({ standard: "标准", minimal: "极简" })[key]

test("DSH uses the supplied preset catalog, including custom and broken modes", () => {
  assert.deepEqual(options.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "standard", enabled: true },
    { id: "minimal", enabled: true },
    { id: "custom", enabled: true },
    { id: "broken", enabled: false },
  ])
  assert.equal(options.at(-1).disabledReason, "Missing plugin")
  assert.deepEqual(dshAgentPresetOptions({ ...runtime, runtimeType: "codex" }), [])
})

test("new sessions prefer the explicit choice, then the configured runtime default", () => {
  assert.equal(dshNewSessionAgentPreset(runtime, options), "minimal")
  assert.equal(dshNewSessionAgentPreset(runtime, options, "custom"), "custom")
  assert.equal(dshNewSessionAgentPreset(runtime, options, "broken"), "minimal")
  assert.equal(dshNewSessionAgentPreset(runtime, options, "removed"), "minimal")
  assert.equal(dshNewSessionAgentPreset({ ...runtime, config: null }, options), "standard")
  assert.equal(dshNewSessionAgentPreset({ ...runtime, runtimeType: "claude" }, options, "minimal"), undefined)
})

test("missing defaults fall back to a usable preset, and an entirely broken catalog has no selection", () => {
  const noDefault = { ...runtime, config: null, defaults: {} }
  assert.equal(dshNewSessionAgentPreset(noDefault, options), "standard")
  assert.equal(dshNewSessionAgentPreset(runtime, options.filter((option) => !option.enabled)), undefined)
  assert.equal(dshNewSessionAgentPreset(runtime, []), "minimal")
  assert.equal(dshNewSessionAgentPreset(noDefault, [], "removed"), undefined)
})

test("preset names localize builtins and preserve custom or removed session modes", () => {
  assert.equal(dshAgentPresetLabel("standard", options, translate), "标准")
  assert.equal(dshAgentPresetLabel("minimal", options, translate), "极简")
  assert.equal(dshAgentPresetLabel("custom", options, translate), "代码审查")
  assert.equal(dshAgentPresetLabel("removed", options, translate), "removed")
  assert.equal(dshAgentPresetLabel("minimal", [], translate), "极简")
  assert.equal(dshAgentPresetLabel("standard", [{ ...options[0], label: "团队默认模式" }], translate), "团队默认模式")
})
