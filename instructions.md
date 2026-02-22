Here are the changes to make manually:

1. Add buildRegistryEntityMap function
   After the loadExistingRegistry function (around the "package.json resolution" section), add a new section:

```ts
// ---------------------------------------------------------------------------
// Registry entity map (used to detect intra-registry dependencies)
// ---------------------------------------------------------------------------

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
```

2. Add resolveRegistryDep function
   After extractShadcnComponent, add:

```ts
function resolveRegistryDep(
  importPath: string,
  registryEntityMap: Map<string, string>,
): string | null {
  for (const alias of LOCAL_ALIASES) {
    if (!importPath.startsWith(alias)) continue
    const rest = importPath.slice(alias.length)
    if (registryEntityMap.has(rest)) return registryEntityMap.get(rest)!
    const parts = rest.split('/')
    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`
      if (registryEntityMap.has(key)) return registryEntityMap.get(key)!
    }
    break
  }
  return null
}
```

3. Update analyzeFile signature + body
   Add registryEntityMap: Map<string, string> as a third parameter, then insert a check between the shadcn check and the isLocalImport check:

```ts
// NEW: check alias imports for intra-registry dependencies before skipping them
if (!importPath.startsWith('.')) {
  const registryDep = resolveRegistryDep(importPath, registryEntityMap)
  if (registryDep) {
    registry.add(registryDep)
    continue
  }
}
```

4. Update processEntity signature + body
   Add registryEntityMap: Map<string, string> as a sixth parameter.

Pass it to analyzeFile:

```ts
// change:
analyzeFile(content, packageMap)
// to:
analyzeFile(content, packageMap, registryEntityMap)
After the unknownPkgs warning block, add self-reference removal:


allRegistry.delete(toKebabCase(entityName))
```

5. Update main
   After buildPackageMap, add:

```ts
const registryEntityMap = buildRegistryEntityMap(REGISTRY_DIR)
console.log(`🗂   Found ${registryEntityMap.size} registry entities for dependency detection`)
At the processEntity call, add registryEntityMap as the last argument:


processEntity(categoryName, entityName, entityDir, category, packageMap, registryEntityMap)
```
