import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ProjectAllowlistEntry { id: string; name?: string; root: string }
export interface WorkbenchConfig {
  /** Bare `tectonic` uses PATH; an explicit executable path may be supplied by the host. */
  compiler?: string;
  maxConcurrentBuilds?: number;
  maxQueuedBuilds?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxBuildHistory?: number;
}
export interface AutoResearchWebConfig { projects?: ProjectAllowlistEntry[]; workbench?: WorkbenchConfig }
export interface ProjectSettingsService {
  readProjectSettingsDocument(input: { projectId: string; root: string }): Promise<{ revision: string | number; document?: object; settings?: object }>;
  validateProjectSettingsCandidate(input: { projectId: string; root: string; candidate: object }): Promise<{ valid: boolean; errors?: object[]; warnings?: object[]; effective?: object }>;
  patchProjectSettingsDocument(input: { projectId: string; root: string; expectedRevision: string | number; operations: object[] }): Promise<{ revision: string | number; document?: object; settings?: object }>;
}
export interface AutoResearchWebContext {
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void };
  autoresearchSettings?: ProjectSettingsService;
  get?(name: 'autoresearchSettings'): ProjectSettingsService | undefined;
  effect?(factory: () => void | (() => void), name?: string): void;
}
export declare function apply(ctx: AutoResearchWebContext, config?: AutoResearchWebConfig): Promise<() => void>;
export declare const API_PREFIX: string;
export declare const inject: readonly ['webServer'];
