import { useState, useEffect, useCallback } from 'react'
import { createContext, useContext } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import styles from './Toast.module.css'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const add = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    if (duration > 0) setTimeout(() => remove(id), duration)
  }, [])

  const remove = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = {
    success: (msg) => add(msg, 'success'),
    error:   (msg) => add(msg, 'error', 6000),
    warning: (msg) => add(msg, 'warning'),
    info:    (msg) => add(msg, 'info'),
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={styles.container}>
        {toasts.map(t => (
          <div key={t.id} className={`${styles.toast} ${styles[t.type]}`}>
            <span className={styles.icon}>
              {t.type === 'success' && <CheckCircle size={16}/>}
              {t.type === 'error'   && <XCircle size={16}/>}
              {t.type === 'warning' && <AlertTriangle size={16}/>}
              {t.type === 'info'    && <Info size={16}/>}
            </span>
            <span className={styles.message}>{t.message}</span>
            <button className={styles.close} onClick={() => remove(t.id)}><X size={13}/></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
