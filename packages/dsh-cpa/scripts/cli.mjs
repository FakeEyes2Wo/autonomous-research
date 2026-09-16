import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { DEFAULT_CONFIG, nativeConfigToConfig } from '../src/index.mjs'

export const argv = process.argv.slice(2)
export const has = (name) => argv.includes(name)
export const valueAfter = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

export async function loadConfig(configPath) {
  if (!configPath) return DEFAULT_CONFIG
  return nativeConfigToConfig(parse(await readFile(configPath, 'utf8')))
}
