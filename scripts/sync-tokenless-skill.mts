import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const maintenanceModule = pathToFileURL(path.join(repoRoot, 'packages/cli/dist/src/bootstrap/setup-workflow.js')).href
const { installTokenlessSkills } = await import(maintenanceModule)
const { check } = await installTokenlessSkills({ sourceRoot: path.join(repoRoot, 'skills') })
console.log(JSON.stringify(check, null, 2))
