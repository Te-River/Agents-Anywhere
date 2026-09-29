"use client"

import * as React from "react"
import { dashboardApi } from "@/features/dashboard/api"
import type { DeviceRuntimeView } from "@/features/dashboard/types"

export function useDshAgentPresets(
  token: string | null | undefined,
  connectorId: string,
  runtimeId: string,
  enabled: boolean,
) {
  const scope = `${connectorId}:${runtimeId}`
  const [result, setResult] = React.useState<{
    scope: string
    runtime: DeviceRuntimeView | null
    loading: boolean
    error: string | null
  } | null>(null)

  React.useEffect(() => {
    if (!enabled || !token || !connectorId || !runtimeId) return
    let cancelled = false
    setResult((current) => ({
      scope,
      runtime: current?.scope === scope ? current.runtime : null,
      loading: true,
      error: null,
    }))
    // Refresh the existing discovery data so the Web sees the preset options
    // already collected by the Connector, without adding a catalog endpoint.
    dashboardApi.discoverConnectorRuntimes(token, connectorId)
      .then(({ runtimes }) => {
        const runtime = runtimes.find((item) => item.runtimeId === runtimeId && item.runtimeType === "dsh") ?? null
        if (!cancelled) setResult({ scope, runtime, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult((current) => ({
          scope,
          runtime: current?.scope === scope ? current.runtime : null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    return () => { cancelled = true }
  }, [connectorId, enabled, runtimeId, scope, token])

  const active = enabled && Boolean(token && connectorId && runtimeId)
  return {
    runtime: active && result?.scope === scope ? result.runtime : null,
    loading: active && (result?.scope !== scope || result?.loading === true),
    error: active && result?.scope === scope ? result.error : null,
  }
}
