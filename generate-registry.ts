#!/usr/bin/env npx ts-node
/**
 * generate-registry.ts
 *
 * Scans the `registry/` directory and generates (or updates) a `registry.json`
 * file compatible with the shadcn registry schema.
 *
 * Usage:
 *   npx ts-node generate-registry.ts [options] [...targets]
 *
 * Options:
 *   --no-override   Skip items that already exist in registry.json
 *                   (default: existing items are overwritten)
 *
 * Targets (optional):
 *   Limit processing to specific items. Each target can be:
 *     category/entity   e.g. components/button, hooks/use-debounce
 *     entity            e.g. button  (searched across all categories)
 *
 * Examples:
 *   npx ts-node generate-registry.ts
 *   npx ts-node generate-registry.ts --no-override
 *   npx ts-node generate-registry.ts components/button
 *   npx ts-node generate-registry.ts --no-override hooks/use-debounce components/card
 *   npx ts-node generate-registry.ts button use-debounce
 *
 * Expected directory layout:
 *   registry/
 *     components/
 *       button/
 *         button.tsx
 *         button.module.css
 *         button.stories.tsx   ← excluded automatically
 *         button.test.tsx      ← excluded automatically
 *     hooks/
 *       use-debounce/
 *         use-debounce.ts
 *     lib/
 *       utils/
 *         utils.ts
 *     types/
 *       form-types/
 *         form-types.ts
 *     styles/
 *       animations/
 *         animations.css
 */

import * as fs from 'fs'
import * as path from 'path'
import { toKebabCase } from 'remeda'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REGISTRY_DIR = path.resolve('registry')
const OUTPUT_FILE = path.resolve('registry.json')
const PACKAGE_JSON = path.resolve('package.json')
const REGISTRY_NAME = 'my-registry'
const REGISTRY_HOMEPAGE = 'https://your-registry-url.com'

const ENTITY_CATEGORIES: Record<
  string,
  { itemType: RegistryItemType; fileType: RegistryFileType; targetDir: string }
> = {
  components: {
    itemType: 'registry:component',
    fileType: 'registry:component',
    targetDir: 'components',
  },
  hooks: {
    itemType: 'registry:hook',
    fileType: 'registry:hook',
    targetDir: 'hooks',
  },
  lib: {
    itemType: 'registry:lib',
    fileType: 'registry:lib',
    targetDir: 'lib',
  },
  types: {
    itemType: 'registry:lib',
    fileType: 'registry:lib',
    targetDir: 'types',
  },
  styles: {
    itemType: 'registry:component',
    fileType: 'registry:style',
    targetDir: 'styles',
  },
}

/**
 * Path aliases that resolve to local files in your project.
 * Imports starting with these prefixes are skipped during dependency extraction.
 */
const LOCAL_ALIASES = ['@/', '~/', '#']

/**
 * Patterns to detect shadcn/ui component imports.
 * The first capture group must be the component name (e.g. "button").
 */
const SHADCN_UI_PATTERNS: RegExp[] = [
  /^@\/components\/ui\/(.+)$/,
  /^~\/components\/ui\/(.+)$/,
  /^components\/ui\/(.+)$/,
]

/**
 * Files matching any of these patterns are excluded from the registry.
 * This prevents story, test, and spec files from being picked up
 * despite having a .tsx / .ts extension.
 */
const EXCLUDED_PATTERNS: RegExp[] = [
  /\.stories\.[tj]sx?$/,
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RegistryItemType =
  | 'registry:component'
  | 'registry:block'
  | 'registry:ui'
  | 'registry:hook'
  | 'registry:lib'
  | 'registry:page'

type RegistryFileType =
  | 'registry:component'
  | 'registry:style'
  | 'registry:hook'
  | 'registry:lib'
  | 'registry:page'
  | 'registry:file'

interface RegistryFile {
  path: string
  type: RegistryFileType
  target: string
}

interface RegistryItem {
  name: string
  type: RegistryItemType
  title: string
  description?: string
  dependencies?: string[]
  registryDependencies?: string[]
  files: RegistryFile[]
}

interface Registry {
  $schema: string
  name: string
  homepage: string
  items: RegistryItem[]
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  noOverride: boolean
  targets: Set<string>
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2)
  const noOverride = args.includes('--no-override')
  const positional = args.filter((a) => !a.startsWith('--'))

  const targets = new Set<string>()

  for (const target of positional) {
    if (target.includes('/')) {
      targets.add(target)
    } else {
      let found = false
      for (const category of Object.keys(ENTITY_CATEGORIES)) {
        const entityDir = path.join(REGISTRY_DIR, category, target)
        if (fs.existsSync(entityDir)) {
          targets.add(`${category}/${target}`)
          found = true
        }
      }
      if (!found) {
        console.warn(
          `⚠  Target "${target}" not found in any category — skipping.`,
        )
      }
    }
  }

  return { noOverride, targets }
}

// ---------------------------------------------------------------------------
// registry.json helpers
// ---------------------------------------------------------------------------

function loadExistingRegistry(): Registry | null {
  if (!fs.existsSync(OUTPUT_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8')) as Registry
  } catch {
    console.warn(
      '⚠  Existing registry.json could not be parsed — it will be overwritten.',
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Registry entity map (used to detect intra-registry dependencies)
// ---------------------------------------------------------------------------

/**
 * Builds a map of `"category/entityName"` → kebab-case item name for every
 * entity directory found under REGISTRY_DIR.  Used to resolve alias imports
 * like `@/hooks/use-debounce` into registry dependency names.
 */
function buildRegistryEntityMap(registryDir: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const categoryName of Object.keys(ENTITY_CATEGORIES)) {
    const categoryDir = path.join(registryDir, categoryName)
    if (!fs.existsSync(categoryDir)) continue
    for (const entry of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      map.set(`${categoryName}/${entry.name}`, toKebabCase(entry.name))
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// package.json resolution
// ---------------------------------------------------------------------------

function loadPackageJson(): PackageJson {
  if (!fs.existsSync(PACKAGE_JSON)) {
    console.warn(
      '⚠  No package.json found — dependency versions will be omitted.',
    )
    return {}
  }
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8')) as PackageJson
}

function buildPackageMap(pkg: PackageJson): Map<string, string> {
  const map = new Map<string, string>()
  for (const deps of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
  ]) {
    for (const [name, version] of Object.entries(deps ?? {})) {
      map.set(name, `${name}@${version}`)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function extractImportPaths(source: string): string[] {
  const results = new Set<string>()
  const staticRe =
    /(?:^|\n)\s*(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynRe = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = staticRe.exec(source)) !== null) results.add(m[1])
  while ((m = dynRe.exec(source)) !== null) results.add(m[1])
  return [...results]
}

function toPackageName(importPath: string): string {
  if (importPath.startsWith('@'))
    return importPath.split('/').slice(0, 2).join('/')
  return importPath.split('/')[0]
}

function isLocalImport(importPath: string): boolean {
  if (importPath.startsWith('.')) return true
  return LOCAL_ALIASES.some((alias) => importPath.startsWith(alias))
}

function extractShadcnComponent(importPath: string): string | null {
  for (const pattern of SHADCN_UI_PATTERNS) {
    const match = importPath.match(pattern)
    if (match) return match[1]
  }
  return null
}

/**
 * If `importPath` is an alias import (e.g. `@/hooks/use-debounce`) that
 * resolves to a known registry entity, returns its item name; otherwise null.
 */
function resolveRegistryDep(
  importPath: string,
  registryEntityMap: Map<string, string>,
): string | null {
  for (const alias of LOCAL_ALIASES) {
    if (!importPath.startsWith(alias)) continue
    const rest = importPath.slice(alias.length)
    // Exact match: "hooks/use-debounce"
    if (registryEntityMap.has(rest)) return registryEntityMap.get(rest)!
    // Deeper path: "hooks/use-debounce/use-debounce" → take first two segments
    const parts = rest.split('/')
    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`
      if (registryEntityMap.has(key)) return registryEntityMap.get(key)!
    }
    break
  }
  return null
}

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
])

interface FileDeps {
  npm: Set<string>
  registry: Set<string>
  unresolved: Set<string>
}

function analyzeFile(
  source: string,
  packageMap: Map<string, string>,
  registryEntityMap: Map<string, string>,
): FileDeps {
  const npm = new Set<string>()
  const registry = new Set<string>()
  const unresolved = new Set<string>()

  for (const importPath of extractImportPaths(source)) {
    const shadcnName = extractShadcnComponent(importPath)
    if (shadcnName) {
      registry.add(shadcnName)
      continue
    }
    // Check alias imports for intra-registry dependencies before skipping them
    if (!importPath.startsWith('.')) {
      const registryDep = resolveRegistryDep(importPath, registryEntityMap)
      if (registryDep) {
        registry.add(registryDep)
        continue
      }
    }
    if (isLocalImport(importPath)) continue
    const pkgName = toPackageName(importPath)
    if (NODE_BUILTINS.has(pkgName)) continue
    if (packageMap.has(pkgName)) {
      npm.add(packageMap.get(pkgName)!)
    } else {
      unresolved.add(pkgName)
    }
  }

  return { npm, registry, unresolved }
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function walkDir(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walkDir(fullPath))
    else results.push(fullPath)
  }
  return results
}

const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.js', '.jsx'])

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath)
  if (!SOURCE_EXTENSIONS.has(ext) && !filePath.endsWith('.css')) return false
  return !EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath))
}

function inferFileType(
  filePath: string,
  categoryDefault: RegistryFileType,
): RegistryFileType {
  if (filePath.endsWith('.css')) return 'registry:style'
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase()
  if (base.startsWith('use-') || base.endsWith('-hook')) return 'registry:hook'
  if (base === 'utils' || base === 'helpers' || base === 'lib')
    return 'registry:lib'
  return categoryDefault
}

function toTitle(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Process a single entity
// ---------------------------------------------------------------------------

function processEntity(
  categoryName: string,
  entityName: string,
  entityDir: string,
  category: (typeof ENTITY_CATEGORIES)[string],
  packageMap: Map<string, string>,
  registryEntityMap: Map<string, string>,
): RegistryItem | null {
  const sourceFiles = walkDir(entityDir).filter(isSourceFile)

  if (sourceFiles.length === 0) {
    console.warn(
      `  ⚠  Skipping "${categoryName}/${entityName}" — no source files found.`,
    )
    return null
  }

  const allNpm = new Set<string>()
  const allRegistry = new Set<string>()
  const allUnresolved = new Set<string>()

  const registryFiles: RegistryFile[] = sourceFiles.map((absPath) => {
    const content = fs.readFileSync(absPath, 'utf-8')

    if (!absPath.endsWith('.css')) {
      const { npm, registry, unresolved } = analyzeFile(content, packageMap, registryEntityMap)
      npm.forEach((d) => allNpm.add(d))
      registry.forEach((d) => allRegistry.add(d))
      unresolved.forEach((d) => allUnresolved.add(d))
    }

    const fileName = path.basename(absPath)
    return {
      path: `registry/${categoryName}/${entityName}/${fileName}`,
      type: inferFileType(absPath, category.fileType),
      target: `${category.targetDir}/${entityName}/${fileName}`,
    }
  })

  const unknownPkgs = [...allUnresolved]
  if (unknownPkgs.length > 0) {
    console.warn(
      `  ⚠  "${categoryName}/${entityName}" has imports not found in package.json (skipped): ${unknownPkgs.join(', ')}`,
    )
  }

  // Remove self-references (a file importing its own entity)
  allRegistry.delete(toKebabCase(entityName))

  const item: RegistryItem = {
    name: toKebabCase(entityName),
    type: category.itemType,
    title: toTitle(entityName),
    files: registryFiles,
  }

  if (allNpm.size > 0) item.dependencies = [...allNpm].sort()
  if (allRegistry.size > 0) item.registryDependencies = [...allRegistry].sort()

  return item
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv)

  if (!fs.existsSync(REGISTRY_DIR)) {
    console.error(`❌  Registry directory not found: ${REGISTRY_DIR}`)
    process.exit(1)
  }

  const pkg = loadPackageJson()
  const packageMap = buildPackageMap(pkg)
  console.log(`📦  Loaded ${packageMap.size} packages from package.json`)

  const registryEntityMap = buildRegistryEntityMap(REGISTRY_DIR)
  console.log(`🗂   Found ${registryEntityMap.size} registry entities for dependency detection`)

  const existingRegistry = loadExistingRegistry()
  const existingItemMap = new Map<string, RegistryItem>(
    (existingRegistry?.items ?? []).map((item) => [item.name, item]),
  )

  if (existingRegistry) {
    console.log(
      `📄  Found existing registry.json with ${existingItemMap.size} item(s)`,
    )
  }
  if (options.noOverride) {
    console.log(`🔒  --no-override enabled — existing items will be kept as-is`)
  }
  if (options.targets.size > 0) {
    console.log(`🎯  Targeting: ${[...options.targets].join(', ')}`)
  }
  console.log()

  const presentDirs = new Set(
    fs
      .readdirSync(REGISTRY_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  )
  const activeCategories = Object.keys(ENTITY_CATEGORIES).filter((name) =>
    presentDirs.has(name),
  )

  if (activeCategories.length === 0) {
    console.warn(
      '⚠  No recognised category directories found. Expected:',
      Object.keys(ENTITY_CATEGORIES).join(', '),
    )
    process.exit(0)
  }

  const summary = { added: 0, updated: 0, skipped: 0 }
  const updatedItemMap = new Map<string, RegistryItem>(existingItemMap)

  for (const categoryName of activeCategories) {
    const category = ENTITY_CATEGORIES[categoryName]
    const categoryDir = path.join(REGISTRY_DIR, categoryName)

    const entityNames = fs
      .readdirSync(categoryDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((entityName) => {
        if (options.targets.size === 0) return true
        return (
          options.targets.has(`${categoryName}/${entityName}`) ||
          options.targets.has(entityName)
        )
      })

    if (entityNames.length === 0) continue

    console.log(`📁  ${categoryName}/`)

    for (const entityName of entityNames) {
      const alreadyExists = existingItemMap.has(entityName)

      if (options.noOverride && alreadyExists) {
        console.log(`  –  ${entityName}  (skipped, already exists)`)
        summary.skipped++
        continue
      }

      const entityDir = path.join(categoryDir, entityName)
      const item = processEntity(
        categoryName,
        entityName,
        entityDir,
        category,
        packageMap,
        registryEntityMap,
      )
      if (!item) continue

      updatedItemMap.set(entityName, item)

      const depsLog = [
        item.dependencies?.length ? `npm: ${item.dependencies.join(', ')}` : '',
        item.registryDependencies?.length
          ? `registry: ${item.registryDependencies.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' | ')

      if (alreadyExists) {
        console.log(
          `  ↺  ${entityName}  (updated)${depsLog ? `  — ${depsLog}` : ''}`,
        )
        summary.updated++
      } else {
        console.log(
          `  ✓  ${entityName}  (added)${depsLog ? `  — ${depsLog}` : ''}`,
        )
        summary.added++
      }
    }
  }

  const registry: Registry = {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: existingRegistry?.name ?? REGISTRY_NAME,
    homepage: existingRegistry?.homepage ?? REGISTRY_HOMEPAGE,
    items: [...updatedItemMap.values()],
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(registry, null, 2), 'utf-8')

  console.log('\n✅  registry.json updated:')
  if (summary.added) console.log(`   ${summary.added} added`)
  if (summary.updated) console.log(`   ${summary.updated} updated`)
  if (summary.skipped)
    console.log(`   ${summary.skipped} skipped (--no-override)`)
  console.log(`   ${updatedItemMap.size} total item(s) in registry`)
}

main()
