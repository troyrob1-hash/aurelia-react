import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import styles from './OfflineBanner.module.css'

export default function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)

  useEffect(() => {
    const on  = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  if (!offline) return null

  return (
    <div className={styles.banner}>
      <WifiOff size={14}/>
      You're offline — changes will sync when reconnected
    </div>
  )
}
