import { create } from 'zustand'

// In-session UI preferences. Survives mount/unmount of components (e.g. tab
// route changes) but resets on full page reload. For cross-login persistence
// of these preferences, see CLAUDE.md Known issues — the user-profile
// preferences path at orgs/{orgId}/users/{uid}.preferences is the planned home.
export const useUIStore = create((set) => ({
  // Inventory tab: 'grouped' (categories) | 'flat' (A-Z, no categories).
  inventoryViewMode: 'grouped',
  setInventoryViewMode: (mode) => set({ inventoryViewMode: mode }),
}))
