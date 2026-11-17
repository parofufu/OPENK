// Build lib/plugin.js from src/plugin.ts with Node's own type stripper.
// Zero dependencies: the published package must not need a toolchain to load,
// and `scripts/build.mjs` only relies on `node:module` (Node >= 22.13).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'src', 'plugin.ts'), 'utf8')
const code = stripTypeScriptTypes(source, { mode: 'strip' })
await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(
  join(root, 'lib', 'plugin.js'),
  `// Generated from src/plugin.ts by scripts/build.mjs. Do not edit.\n${code}`,
  'utf8',
)
console.log('built lib/plugin.js')
