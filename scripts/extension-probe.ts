import { loadNativeBootstrap } from './bootstrap-loader.ts'
import { resolve } from 'node:path'

// Only imports and validates the explicitly trusted entry; package lifecycle runs in its actual host.
try {
  const entry = process.argv[2]
  if (!entry || entry !== resolve(entry)) throw new Error('EXTENSION_PROBE_PATH_INVALID')
  const loaded = await loadNativeBootstrap(entry,{timeoutMs:15000})
  console.log(JSON.stringify({schema:1,manifest:loaded.metadata.manifest,contentIdentity:loaded.metadata.contentIdentity}))
} catch(error) {
  console.error(error instanceof Error && 'code' in error && typeof error.code==='string' ? error.code : 'EXTENSION_IMPORT_FAILED')
  process.exitCode=1
}
