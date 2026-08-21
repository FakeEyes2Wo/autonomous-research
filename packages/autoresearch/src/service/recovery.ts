export async function withRetry<T>(operation: () => Promise<T>, label: string, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        // Temporary DSH/LLM/tool failures are retried once.
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`)
}
