/**
 * Aurelia FMS — Role-based access control helpers
 *
 * ROLE MODEL (additive — a user can hold multiple roles):
 *
 *   staff / manager   Sees only assigned location(s) and/or region(s).
 *                     Cannot approve sales or administer the system.
 *   director          Sees assigned region(s). Can approve sales.
 *                     Cannot administer the system.
 *   vp                Sees ALL locations in the tenant. Can approve sales.
 *                     Cannot administer the system.
 *   admin             Sees ALL locations. Can approve sales. Full admin powers
 *                     (manage users, roles, regions, locations, API keys, SSO).
 *
 * VISIBILITY MODEL:
 *
 *   Admins and VPs see everything — assignedRegions/assignedLocations are ignored.
 *
 *   Directors and Managers see the union of:
 *     - Locations in every region whose ID is in user.managedRegionIds
 *     - Individual location names in user.assignedLocations (ad-hoc overrides)
 *
 * REGIONS:
 *
 *   A region is a named bucket of locations stored at
 *     tenants/{orgId}/regions/{regionId}
 *   with shape { id, name, locations: string[], ... }.
 *
 *   Region names are mutable and historically derived from director names
 *   ("Troy Robinson", "Jane Smith") but can be renamed freely. Assignment
 *   happens by stable ID, not by name, so renames don't break access.
 *
 * BACKWARDS COMPATIBILITY:
 *
 *   - Legacy user docs have `user.role: 'admin'` (singular string).
 *   - New user docs have `user.roles: ['admin', 'vp']` (array).
 *   - getUserRoles(user) handles both transparently.
 *   - Location docs may still have a legacy `director: "Name"` string — this
 *     is no longer used for access control, only for display. The regions
 *     collection is authoritative for visibility.
 */

// ── Role constants ────────────────────────────────────────────
export const ROLES = Object.freeze({
  STAFF:    'staff',
  MANAGER:  'manager',
  DIRECTOR: 'director',
  VP:       'vp',
  ADMIN:    'admin',
})

export const ROLE_LABELS = Object.freeze({
  staff:    'Staff',
  manager:  'Manager',
  director: 'Director',
  vp:       'Vice President',
  admin:    'Admin',
})

// Order matters — the Settings UI renders these in this order
export const ASSIGNABLE_ROLES = Object.freeze([
  { value: 'manager',  label: 'Manager',         hint: 'Sees only assigned regions/locations' },
  { value: 'director', label: 'Director',        hint: 'Sees assigned regions; can approve sales' },
  { value: 'vp',       label: 'Vice President',  hint: 'Sees all locations; can approve sales' },
  { value: 'admin',    label: 'Admin',           hint: 'Full operational + administrative access' },
])

// ── Role normalization ────────────────────────────────────────
/**
 * Returns the user's roles as a normalized, lowercase string array.
 * Handles both the legacy `role: 'admin'` string and the new `roles: ['admin']` array.
 * Returns an empty array for users with no roles (they see nothing).
 *
 * Also normalizes 'staff' → 'manager' since they're treated identically.
 */
export function getUserRoles(user) {
  if (!user) return []

  let rawRoles = []

  // New format: array of roles
  if (Array.isArray(user.roles) && user.roles.length > 0) {
    rawRoles = user.roles
  }
  // Legacy format: single role string
  else if (typeof user.role === 'string' && user.role.trim()) {
    rawRoles = [user.role]
  }

  return rawRoles
    .map(r => String(r).toLowerCase().trim())
    .filter(Boolean)
    .map(r => r === 'staff' ? 'manager' : r)  // staff and manager are the same tier
}

function hasRole(user, role) {
  return getUserRoles(user).includes(role)
}

// ── Permission predicates ─────────────────────────────────────
/**
 * Can this user see every location in the tenant (unrestricted)?
 * True for: VP, Admin
 */
export function canSeeAllLocations(user) {
  const roles = getUserRoles(user)
  return roles.includes('vp') || roles.includes('admin')
}

/**
 * Can this user approve sales submissions?
 * True for: Director, VP, Admin
 */
export function canApproveSales(user) {
  const roles = getUserRoles(user)
  return roles.includes('director') || roles.includes('vp') || roles.includes('admin')
}

/**
 * Can this user approve invoices in Purchasing?
 * Same rules as sales approval.
 */
export function canApproveInvoices(user) {
  return canApproveSales(user)
}

/**
 * Can this user perform administrative actions — manage users, roles, regions,
 * locations, API keys, SSO configuration, billing?
 * True for: Admin only (explicitly NOT VP).
 */
export function canAdministerSystem(user) {
  return hasRole(user, 'admin')
}

/**
 * Alias — currently the same as canAdministerSystem, but kept separate because
 * a future "delegated admin" tier might split user management out.
 */
export function canManageUsers(user) {
  return canAdministerSystem(user)
}

// ── Location visibility ──────────────────────────────────────
/**
 * Resolves the set of locations this user is allowed to see.
 *
 * Inputs:
 *   - user: the current user (from auth store)
 *   - allLocations: Location[] — array of location objects with shape
 *       { id, name, director, active, ... }
 *   - regionsById: map of regionId → region doc { id, name, locations[] }
 *     where region.locations is an array of location NAMES (strings)
 *
 * Returns: a FILTERED array of location objects (same shape as input).
 *
 * Rules:
 *   - Admins and VPs get everything
 *   - Directors and Managers get the union of their regions' locations
 *     plus any individually-assigned locations
 *   - Users with no recognized role get an empty array
 */
export function getVisibleLocationsForUser(user, allLocations, regionsById = {}) {
  if (!user || !Array.isArray(allLocations)) return []

  // Admins and VPs see everything
  if (canSeeAllLocations(user)) return allLocations

  const roles = getUserRoles(user)
  if (!roles.includes('director') && !roles.includes('manager')) {
    return []
  }

  // Collect allowed location NAMES from regions + ad-hoc assignments.
  // Regions and user.assignedLocations are still identified by name strings,
  // not IDs, because names are the stable human-facing identifier.
  const allowedNames = new Set()

  const regionIds = Array.isArray(user.managedRegionIds) ? user.managedRegionIds : []
  regionIds.forEach(regionId => {
    const region = regionsById[regionId]
    if (region && Array.isArray(region.locations)) {
      region.locations.forEach(name => allowedNames.add(name))
    }
  })

  const directAssignments = Array.isArray(user.assignedLocations) ? user.assignedLocations : []
  directAssignments.forEach(name => allowedNames.add(name))

  // Filter the location array
  return allLocations.filter(loc => loc?.name && allowedNames.has(loc.name))
}

/**
 * Returns just the visible location NAMES as a string array.
 * Useful for dropdown keys or lookups.
 */
export function getAssignedLocationNames(user, allLocations, regionsById = {}) {
  return getVisibleLocationsForUser(user, allLocations, regionsById).map(loc => loc.name)
}

// ── Guardrails for role/region changes ────────────────────────
/**
 * Validates a proposed role change. Returns null if the change is allowed,
 * or a human-readable error string if it should be blocked.
 *
 * Guardrails:
 *   1. Cannot remove your own admin role if you're the last admin
 *   2. Must have at least one role assigned
 *   3. All roles must be from the valid set
 */
export function validateRoleChange({ currentUser, targetUser, newRoles, allAdminUids }) {
  if (!targetUser) return 'User not found'

  const newRolesArr = Array.isArray(newRoles) ? newRoles : []

  // Rule 1: cannot remove yourself as admin if you're the last admin
  if (currentUser?.uid === targetUser.uid) {
    const isCurrentlyAdmin = getUserRoles(currentUser).includes('admin')
    const willRemainAdmin  = newRolesArr.includes('admin')
    if (isCurrentlyAdmin && !willRemainAdmin) {
      const otherAdmins = (allAdminUids || []).filter(uid => uid !== currentUser.uid)
      if (otherAdmins.length === 0) {
        return 'You cannot remove your admin role — you are the last admin in the tenant.'
      }
    }
  }

  // Rule 2: at least one role
  if (newRolesArr.length === 0) {
    return 'At least one role must be assigned.'
  }

  // Rule 3: valid role values
  const validRoles = new Set(ASSIGNABLE_ROLES.map(r => r.value).concat(['staff']))
  const invalid = newRolesArr.find(r => !validRoles.has(r))
  if (invalid) {
    return `Invalid role: ${invalid}`
  }

  return null
}

/**
 * Returns a human-readable summary of what a user can see. Used in the
 * Settings UI to show "this user sees 15 locations across 2 regions."
 */
export function summarizeUserAccess(user, allLocations, regionsById = {}) {
  const total = Array.isArray(allLocations) ? allLocations.length : 0

  if (canSeeAllLocations(user)) {
    return `All ${total} locations`
  }

  const roles = getUserRoles(user)
  if (!roles.includes('director') && !roles.includes('manager')) {
    return 'No access assigned'
  }

  const visible = getVisibleLocationsForUser(user, allLocations, regionsById)
  const count = visible.length
  const regionCount = (user.managedRegionIds || []).length
  const directCount = (user.assignedLocations || []).length

  const parts = []
  if (regionCount > 0) parts.push(`${regionCount} region${regionCount !== 1 ? 's' : ''}`)
  if (directCount > 0) parts.push(`${directCount} individual location${directCount !== 1 ? 's' : ''}`)

  const sourceStr = parts.length > 0 ? ` across ${parts.join(' + ')}` : ''
  return `${count} location${count !== 1 ? 's' : ''}${sourceStr}`
}
