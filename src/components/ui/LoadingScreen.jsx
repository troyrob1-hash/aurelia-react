import styles from './LoadingScreen.module.css'

export default function LoadingScreen() {
  return (
    <div className={styles.screen}>
      <div className={styles.logo}>
        <div className={styles.logoBox}>fooda</div>
        <span className={styles.logoName}>Aurelia</span>
      </div>
      <div className={styles.spinner} />
    </div>
  )
}
