export interface ToolExecutionContextLike {
  signal: AbortSignal
  agent?: unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec: ToolExecutionContextLike): Promise<unknown>
}
