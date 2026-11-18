// @vitest-environment jsdom

// AllLocationsGrid: when the profile couldn't be read (authStore flags
// profileLoadFailed after its retries) and there is nothing to list, show
// "Couldn't load your locations" with a Reload button instead of an empty grid.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const { state } = vi.hoisted(() => ({ state: { user: null, grouped: {} } }))
vi.mock('@/store/authStore', () => ({ useAuthStore: sel => sel({ user: state.user }) }))
vi.mock('@/store/LocationContext', () => ({
  useLocations: () => ({ visibleLocations: Object.values(state.grouped).flat(), groupedLocations: state.grouped }),
  cleanLocName: n => n.replace(/^(CR|SO)_/, ''),
}))

import AllLocationsGrid from '../src/components/AllLocationsGrid'

afterEach(cleanup)

const renderGrid = () => render(<AllLocationsGrid title="Inventory" subtitle="Select a location to begin counting" onSelectLocation={() => {}} statusLabel="Not counted" />)
const SW = { name: 'CR_Southwest Airlines' }

describe('profile load failure message', () => {
  it('failed profile + nothing to list: visible message and a working Reload', () => {
    state.user = { uid: 'john', role: 'manager', profileLoadFailed: true }
    state.grouped = {}
    const reload = vi.fn()
    const orig = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, reload } })
    renderGrid()
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your locations, reload to try again.")
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(window, 'location', { configurable: true, value: orig })
  })

  it('profile loaded: no message, the location card shows', () => {
    state.user = { uid: 'john', role: 'manager', assignedLocations: ['CR_Southwest Airlines'] }
    state.grouped = { 'Ad-hoc assignments': [SW] }
    renderGrid()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Southwest Airlines')).toBeTruthy()
  })

  it('profile failed but locations are listed anyway (admin/VP see all): no message', () => {
    state.user = { uid: 'troy', role: 'admin', profileLoadFailed: true }
    state.grouped = { Other: [SW] }
    renderGrid()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Southwest Airlines')).toBeTruthy()
  })

  it('profile loaded but genuinely nothing assigned: no load-error message (not a failure)', () => {
    state.user = { uid: 'new', role: 'manager', assignedLocations: [] }
    state.grouped = {}
    renderGrid()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
