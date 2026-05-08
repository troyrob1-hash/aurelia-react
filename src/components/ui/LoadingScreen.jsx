import styles from './LoadingScreen.module.css'

export default function LoadingScreen() {
  return (
    <div className={styles.screen}>
      <div className={styles.logo}>
        <div className={styles.logoMark}>
          <svg width="28" height="28" viewBox="0 0 32 32">
            <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#ffffff"/>
          </svg>
        </div>
        <span className={styles.logoName}>Aurelia</span>
      </div>
      <div className={styles.spinner} />
    </div>
  )
}
