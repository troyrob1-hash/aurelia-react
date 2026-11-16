import { useEffect, useRef, useState } from 'react'
import styles from './InventoryToolbar.module.css'

// Minimal dropdown for the Inventory control row: a trigger button plus a
// popover that closes on outside click, Escape, or (by default) after an item
// is chosen. `children` is a render function given { close } so an item can
// keep the menu open (e.g. the Export format choice).
export default function Menu({ label, buttonContent, buttonClassName = '', align = 'left', disabled, title, children, wide = false }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className={styles.menuWrap} ref={wrap}>
      <button
        type="button"
        className={`${styles.btn} ${buttonClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      >
        {buttonContent}
      </button>
      {open && (
        <div role="menu" aria-label={label}
          className={`${styles.menu} ${align === 'right' ? styles.menuRight : ''} ${wide ? styles.menuWide : ''}`}>
          {children({ close })}
        </div>
      )}
    </div>
  )
}

// One menu row. `kind` picks the ARIA role: plain action, checkbox, or radio.
export function MenuItem({ kind = 'action', checked, disabled, title, onSelect, close, keepOpen = false, className = '', children }) {
  const role = kind === 'checkbox' ? 'menuitemcheckbox' : kind === 'radio' ? 'menuitemradio' : 'menuitem'
  return (
    <button
      type="button"
      role={role}
      aria-checked={kind === 'action' ? undefined : !!checked}
      disabled={disabled}
      title={title}
      className={`${styles.menuItem} ${className}`}
      onClick={() => { onSelect?.(); if (!keepOpen) close?.() }}
    >
      {kind !== 'action' && <span className={styles.menuCheck} aria-hidden="true">{checked ? '✓' : ''}</span>}
      {children}
    </button>
  )
}

export function MenuHeading({ children }) {
  return <div className={styles.menuHeading} role="presentation">{children}</div>
}

export function MenuDivider() {
  return <div className={styles.menuDivider} role="separator" />
}
