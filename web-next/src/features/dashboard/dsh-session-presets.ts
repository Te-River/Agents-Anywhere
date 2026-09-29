"use client"

import * as React from "react"

type SessionIdentity = { id: string; connectorId: string }
type SessionPreset = { id: string; label: string }

const STORAGE_PREFIX = "aa-dsh-session-preset-v1:"
const presets = new Map<string, SessionPreset | null>()
const listeners = new Map<string, Set<() => void>>()

function storageKey(userId: string | null | undefined, session: SessionIdentity | null): string | null {
  return userId && session ? `${STORAGE_PREFIX}${JSON.stringify([userId, session.connectorId, session.id])}` : null
}

function readPreset(key: string | null): SessionPreset | null {
  if (!key || typeof window === "undefined") return null
  if (presets.has(key)) return presets.get(key) ?? null
  let preset: SessionPreset | null = null
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null")
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id.trim()) {
      preset = {
        id: value.id.trim(),
        label: "label" in value && typeof value.label === "string" && value.label.trim() ? value.label.trim() : value.id.trim(),
      }
    }
  } catch {
    // Keep the in-memory cache usable when browser storage is unavailable.
  }
  presets.set(key, preset)
  return preset
}

export function rememberDshSessionPreset(
  userId: string | null | undefined,
  session: SessionIdentity,
  id: string,
  label?: string,
) {
  const key = storageKey(userId, session)
  if (!key || !id.trim() || typeof window === "undefined") return
  const current = readPreset(key)
  const next = {
    id: id.trim(),
    label: label?.trim() || (current?.id === id.trim() ? current.label : id.trim()),
  }
  if (current?.id === next.id && current.label === next.label) return
  presets.set(key, next)
  try {
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // The current tab can still retain the immutable preset through navigation.
  }
  listeners.get(key)?.forEach((listener) => listener())
}

export function migrateDshSessionPreset(
  userId: string | null | undefined,
  from: SessionIdentity,
  to: SessionIdentity,
) {
  const key = storageKey(userId, from)
  const preset = readPreset(key)
  if (!key || !preset || typeof window === "undefined") return
  rememberDshSessionPreset(userId, to, preset.id, preset.label)
  presets.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Storage failures do not prevent binding the real session.
  }
  listeners.get(key)?.forEach((listener) => listener())
}

export function useDshSessionPreset(
  userId: string | null | undefined,
  session: SessionIdentity | null,
) {
  const key = storageKey(userId, session)
  const subscribe = React.useCallback((listener: () => void) => {
    if (!key) return () => {}
    const subscribers = listeners.get(key) ?? new Set<() => void>()
    subscribers.add(listener)
    listeners.set(key, subscribers)
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === key || event.key === null)) {
        presets.delete(key)
        listener()
      }
    }
    window.addEventListener("storage", onStorage)
    return () => {
      subscribers.delete(listener)
      if (subscribers.size === 0) listeners.delete(key)
      window.removeEventListener("storage", onStorage)
    }
  }, [key])
  const getSnapshot = React.useCallback(() => readPreset(key), [key])
  return React.useSyncExternalStore(subscribe, getSnapshot, () => null)
}
