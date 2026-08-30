import type { RoleInput, RoleName, RoleOutput } from '../agents/types.js'

export type AgentCall = (role: RoleName, input: RoleInput, label: string) => Promise<RoleOutput>

export interface ReflexionAbnormalInfo {
  role: RoleName
  round: number
  stopReason: 'agent_error' | 'max_rounds' | 'fatal_flaw' | 'quality_low' | 'timeout' | 'rejected' | 'invalid_output'
  context?: unknown
  result?: unknown
  error?: unknown
}

export interface ReflexionOptions<T> {
  reflexion: (current: T, round: number) => string
  buildInput: (current: T | undefined, round: number, reflexion: string) => RoleInput
  parse: (result: RoleOutput) => T
  apply?: (value: T, round: number) => Promise<void>
  rounds?: number
  validate?: (value: T) => string[]
  maxRetriesPerRound?: number
  onAbnormalExit?: (info: ReflexionAbnormalInfo) => Promise<void>
}

export async function runReflexion<T>(
  call: AgentCall,
  role: RoleName,
  { reflexion, buildInput, parse, apply, rounds = 3, validate, maxRetriesPerRound = 2, onAbnormalExit }: ReflexionOptions<T>,
): Promise<T> {
  const run = (input: RoleInput, label: string) => call(role, input, label)
  const safeRun = async (input: RoleInput, label: string, round: number): Promise<RoleOutput> => {
    try {
      return await run(input, label)
    } catch (error) {
      await onAbnormalExit?.({ role, round, stopReason: 'agent_error', context: input, error })
      throw error
    }
  }
  const runWithRetry = async (input: RoleInput, label: string, round: number, fallback: T): Promise<{ value: T; ok: boolean }> => {
    let feedback = ''
    for (let attempt = 0; attempt <= maxRetriesPerRound; attempt += 1) {
      const output = await safeRun(
        attempt === 0
          ? input
          : buildInput(fallback, round, `${reflexion(fallback, round)}\n\n${feedback}`),
        label,
        round,
      )
      const value = parse(output)
      const errors = validate?.(value) ?? []
      if (errors.length === 0) return { value, ok: true }
      feedback = `Your output is invalid. Missing fields: ${errors.join(', ')}. Please return a complete valid result.`
    }
    return { value: fallback, ok: false }
  }

  let current = parse(await safeRun(buildInput(undefined, 0, ''), `${role} generate`, 0))
  await apply?.(current, 0)
  let converged = false
  let lastRound = 0

  for (let round = 1; round <= rounds; round += 1) {
    lastRound = round
    const { value: next, ok } = await runWithRetry(
      buildInput(current, round, reflexion(current, round)),
      `${role} reflex ${round}`,
      round,
      current,
    )
    if (!ok) {
      await onAbnormalExit?.({ role, round, stopReason: 'invalid_output', context: { current }, result: next })
      break
    }
    if (next === current) {
      converged = true
      break
    }
    await apply?.(next, round)
    current = next
  }

  if (!converged) {
    await onAbnormalExit?.({ role, round: lastRound, stopReason: 'max_rounds', result: current })
  }
  return current
}
