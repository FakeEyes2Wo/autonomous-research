import type { AutoResearchService } from '../service/autoresearch-service.js'

export interface ServiceRegistryLike {
  provide(name: string, service: unknown): unknown
}

export function registerAutoResearchService(ctx: { provide: ServiceRegistryLike['provide'] }, service: AutoResearchService): void {
  ctx.provide('autoresearch', service)
}
