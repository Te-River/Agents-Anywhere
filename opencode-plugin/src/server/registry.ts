/**
 * Endpoint publication lifecycle for one Bridge Hub: publish on start, renew
 * (lease heartbeat) while running, remove on dispose. Delegates the atomic
 * file mechanics to `shared/endpoint-store`.
 */

import type { Logger } from '../shared/logger.js'
import {
  makeEndpointRecord,
  publishEndpoint,
  removeEndpoint,
  type EndpointRecord,
} from '../shared/endpoint-store.js'

export interface EndpointRegistryOptions {
  /**
   * Every configured registry receives the same record; the first entry is the
   * primary one (`path`). Production passes the shared registry plus the
   * spawned Connector's registry (`endpointDirectories`).
   */
  directories: readonly string[]
  pid: number
  port: number
  bridgeId: string
  token: string
  serviceVersion?: string
  logger: Logger
}

export class EndpointRegistry {
  readonly #options: EndpointRegistryOptions
  /** Published path per directory, kept so `remove()` cleans up what we wrote even after a later republish failed. */
  readonly #published = new Map<string, string>()
  #primaryPath: string | null = null
  #locations: string[] = []
  #startedAt = new Date().toISOString()

  constructor(options: EndpointRegistryOptions) {
    this.#options = options
  }

  get path(): string | null {
    return this.#primaryPath
  }

  /** Paths currently published, one per registry that accepted the record. */
  get publishedPaths(): readonly string[] {
    return [...this.#published.values()]
  }

  get locations(): readonly string[] {
    return this.#locations
  }

  /**
   * Publish (or republish) the endpoint file into every configured directory.
   * A directory that cannot be written is logged and skipped — the remaining
   * directories must still serve the endpoint — but an all-directory failure
   * rejects, exactly like the single-directory contract did.
   */
  async publish(locations: readonly string[]): Promise<string> {
    this.#locations = [...new Set(locations)].sort()
    const record = this.#record()
    const failures: Array<{ directory: string; error: string }> = []
    let primaryPath: string | null = null
    for (const directory of this.#options.directories) {
      try {
        const path = await publishEndpoint(directory, record)
        this.#published.set(directory, path)
        primaryPath ??= path
      } catch (error) {
        failures.push({ directory, error: errorName(error) })
      }
    }
    if (primaryPath === null) {
      throw new Error(
        `failed to publish the bridge endpoint into every configured directory: ${failures
          .map((failure) => `${failure.directory} (${failure.error})`)
          .join(', ')}`,
      )
    }
    for (const failure of failures) {
      this.#options.logger.warn('failed to publish the bridge endpoint into one directory', {
        directory: failure.directory,
        error: failure.error,
      })
    }
    this.#primaryPath = primaryPath
    return primaryPath
  }

  /** Update the advertised location set; no-op before the first publish. */
  async setLocations(locations: readonly string[]): Promise<void> {
    this.#locations = [...new Set(locations)].sort()
    if (this.#primaryPath === null) return
    await this.publish(this.#locations)
  }

  /** Lease renewal: rewrite with a fresh timestamp so the file looks alive. */
  async renew(): Promise<void> {
    if (this.#primaryPath === null) return
    this.#startedAt = new Date().toISOString()
    await this.publish(this.#locations)
  }

  /** Remove every file this registry published — all directories, only ours. */
  async remove(): Promise<void> {
    const paths = [...this.#published.values()]
    this.#published.clear()
    this.#primaryPath = null
    for (const path of paths) {
      try {
        await removeEndpoint(path)
      } catch (error) {
        this.#options.logger.warn('failed to remove bridge endpoint file', {
          error: errorName(error),
        })
      }
    }
  }

  #record(): EndpointRecord {
    return makeEndpointRecord({
      bridgeId: this.#options.bridgeId,
      port: this.#options.port,
      token: this.#options.token,
      pid: this.#options.pid,
      locations: this.#locations,
      ...(this.#options.serviceVersion !== undefined
        ? { serviceVersion: this.#options.serviceVersion }
        : {}),
      startedAt: this.#startedAt,
    })
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
