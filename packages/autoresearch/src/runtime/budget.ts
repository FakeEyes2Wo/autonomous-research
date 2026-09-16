import type { JobSpec } from './contracts.js'

export function assertLocalContainment(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') throw new Error(`local process-tree containment is not certified on ${platform}; a containment backend is required`)
}

export function validateLocalBudget(budget: JobSpec['budget']): void {
  for (const key of ['wallMs', 'maxLogBytes', 'maxArtifactBytes'] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < (key === 'wallMs' ? 1 : 0)) throw new Error(`invalid budget ${key}`)
  }
  for (const key of ['cpuSeconds', 'gpuSeconds', 'costMicros'] as const) {
    if (budget[key] !== null) throw new Error(`local backend cannot meter/enforce ${key}; hard limit refused`)
  }
}
