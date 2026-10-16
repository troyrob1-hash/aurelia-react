/**
 * Temporal-dead-zone guard for src/routes/Inventory.jsx.
 *
 * WHY THIS EXISTS: Phase 4 shipped `const zonesOn = hasMultipleZones(zones)`
 * roughly 65 lines ABOVE the `} = useInventory(...)` destructure that declares
 * `zones`. `const` bindings sit in the temporal dead zone until their
 * declaration executes, so every render of the Inventory page threw
 * "Cannot access 'zones' before initialization" — the page was completely
 * dead. The entire suite passed, because the error only exists once React
 * actually invokes the component function.
 *
 * That was the SECOND crash of this class in this feature (Phase 0 referenced
 * `locZonesSnap` without adding it to a Promise.all destructure). Both were
 * invisible to unit tests and fatal in the browser.
 *
 * WHY AN AST AND NOT A LINE SCAN: a positional scan cannot tell render-time
 * code from a deferred callback body. `load` is legitimately referenced inside
 * an async handler defined above the hook — that runs long after the
 * declaration and is perfectly safe — while `toast.error(...)` is a property
 * access that merely shares a name with a binding. A naive scan flags both.
 * Only references evaluated during the synchronous render pass can throw, so
 * this walks the component body and skips anything inside a nested function.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parse } from '@babel/parser'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'src/routes/Inventory.jsx'
const src = readFileSync(resolve(ROOT, FILE), 'utf8')

const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] })

/** The default-exported component function body. */
function findComponentBody(programBody) {
  for (const n of programBody) {
    if (n.type === 'ExportDefaultDeclaration' && n.declaration?.type === 'FunctionDeclaration') {
      return n.declaration.body
    }
  }
  return null
}
const body = findComponentBody(ast.program.body)

/** Walk every node, invoking cb(node, insideNestedFn). */
function walk(node, cb, nested = false, parent = null) {
  if (!node || typeof node.type !== 'string') return
  cb(node, nested, parent)
  const deeper = nested || [
    'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod',
  ].includes(node.type)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, cb, deeper, node))
    else if (v && typeof v.type === 'string') walk(v, cb, deeper, node)
  }
}

describe('Inventory.jsx — no hook binding is read before it is initialized', () => {
  it('locates the component and the useInventory destructure', () => {
    expect(body, 'default-exported component function not found').toBeTruthy()
  })

  // The `const { ... } = useInventory(...)` statement and its bindings.
  const declStmt = body.body.find(st =>
    st.type === 'VariableDeclaration' &&
    st.declarations.some(d =>
      d.init?.type === 'CallExpression' && d.init.callee?.name === 'useInventory'))

  it('finds the destructure statement', () => {
    expect(declStmt).toBeTruthy()
  })

  const names = new Set(
    declStmt.declarations[0].id.properties
      .filter(p => p.value?.type === 'Identifier')
      .map(p => p.value.name))

  it('collects the bindings', () => {
    expect(names.size).toBeGreaterThan(10)
    for (const n of ['zones', 'session', 'items', 'load']) expect(names.has(n)).toBe(true)
  })

  it('NONE is read at render time before the destructure', () => {
    const declEnd = declStmt.end
    const violations = []

    walk(body, (node, nested, parent) => {
      if (nested) return                              // deferred callback body — safe
      if (node.type !== 'Identifier') return
      if (!names.has(node.name)) return
      if (node.end > declEnd) return                  // after the declaration — fine
      // Not a reference: `obj.name`, `{ name: ... }` key, or a declaration id.
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return
      if (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed) return
      if (parent?.type === 'VariableDeclarator' && parent.id === node) return
      if (node.start >= declStmt.start && node.end <= declStmt.end) return   // the destructure itself
      violations.push(`${node.name} @ line ${node.loc.start.line}`)
    })

    expect(violations, `render-time use before declaration:\n  ${violations.join('\n  ')}`).toEqual([])
  })

  it('zonesOn / zonesCompleted / zoneStats are declared after the hook', () => {
    const declEnd = declStmt.end
    const found = {}
    for (const st of body.body) {
      if (st.type !== 'VariableDeclaration') continue
      for (const d of st.declarations) {
        if (d.id?.type === 'Identifier' && ['zonesOn', 'zonesCompleted', 'zoneStats'].includes(d.id.name)) {
          found[d.id.name] = d.start
        }
      }
    }
    for (const sym of ['zonesOn', 'zonesCompleted', 'zoneStats']) {
      expect(found[sym], `${sym} not declared at component top level`).toBeGreaterThan(declEnd)
    }
  })
})
