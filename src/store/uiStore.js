import { create } from 'zustand'

// UI preferences. Survives mount/unmount of components (e.g. tab route
// changes). The Inventory View settings below also survive sign-out / sign-in:
// viewPrefsSync.js loads them from orgs/{orgId}/users/{uid}.preferences.inventory
// on sign-in, writes them back on change, and resets them to these defaults on
// sign-out (shared back-of-house terminals — the next user must not inherit).
export const INVENTORY_VIEW_DEFAULTS = Object.freeze({
  // Inventory tab: 'grouped' (categories) | 'flat' (A-Z, no categories).
  inventoryViewMode: 'grouped',
  // Inventory View menu. Last week's counts show by default (the old "Show
  // prior" / "Blind" toggle, also defaulting to shown); variance on by default.
  inventoryShowPrior: true,
  inventoryShowVariance: true,
})

export const useUIStore = create((set) => ({
  ...INVENTORY_VIEW_DEFAULTS,
  setInventoryViewMode: (mode) => set({ inventoryViewMode: mode }),
  setInventoryShowPrior: (on) => set({ inventoryShowPrior: on }),
  setInventoryShowVariance: (on) => set({ inventoryShowVariance: on }),
}))
