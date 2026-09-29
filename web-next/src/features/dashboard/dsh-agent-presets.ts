import type { DeviceRuntimeView } from "@/features/dashboard/types"

type BuiltinPreset = "standard" | "minimal" | "ptc" | "cordis"

export type DshAgentPresetOption = {
  id: string
  label: string
  description?: string
  enabled: boolean
  disabledReason?: string
}

export function dshAgentPresetOptions(
  runtime: DeviceRuntimeView | null | undefined,
): DshAgentPresetOption[] {
  if (runtime?.runtimeType !== "dsh") return []
  const field = record(runtime.uiSchema?.defaultAgentPreset)
  if (!Array.isArray(field.options)) return []
  return field.options.flatMap((value) => {
    const option = record(value)
    const id = nonEmpty(option.value)
    if (!id) return []
    return [{
      id,
      label: nonEmpty(option.label) ?? id,
      description: nonEmpty(option.description),
      enabled: option.disabled !== true,
      disabledReason: nonEmpty(option.disabledReason),
    }]
  })
}

export function dshNewSessionAgentPreset(
  runtime: DeviceRuntimeView | null | undefined,
  options: readonly DshAgentPresetOption[],
  selectedId?: string,
): string | undefined {
  if (runtime?.runtimeType !== "dsh") return undefined
  const defaultId = nonEmpty(runtime.config?.defaultAgentPreset)
    ?? nonEmpty(runtime.defaults?.defaultAgentPreset)
    ?? nonEmpty(record(record(runtime.schema?.properties).defaultAgentPreset).default)
  // Older bridges can expose a configured default without a preset catalog.
  if (options.length === 0) return defaultId
  return [selectedId, defaultId].find((id) => id && options.some((option) => option.id === id && option.enabled))
    ?? options.find((option) => option.enabled)?.id
}

export function dshAgentPresetLabel(
  id: string,
  options: readonly DshAgentPresetOption[],
  translate: (key: BuiltinPreset) => string,
): string {
  const label = options.find((option) => option.id === id)?.label ?? id
  if (["standard", "minimal", "ptc", "cordis"].includes(id) && label.toLowerCase() === id) return translate(id as BuiltinPreset)
  return label
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
