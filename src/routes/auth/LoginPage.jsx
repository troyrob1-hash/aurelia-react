import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signIn, getUser } from '@/lib/auth'
import { useAuthStore } from '@/store/authStore'
import styles from './Auth.module.css'

export default function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  const { setAuth } = useAuthStore()
  const navigate    = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await signIn(email.trim().toLowerCase(), password)

      if (result.type === 'new_password') {
        navigate('/login', { state: { challenge: 'new_password', session: result.session, email } })
        return
      }

      const attrs = await getUser(result.session.accessToken)
      setAuth(result.session, attrs)
      navigate('/')
    } catch (err) {
      setError(friendlyError(err.message))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoBox}>fooda</div>
          <div>
            <div className={styles.appName}>Aurelia</div>
            <div className={styles.appSub}>A Fooda Management Suite</div>
          </div>
        </div>

        <h1 className={styles.heading}>Sign in</h1>

        {error && <div className={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@fooda.com"
              className={styles.input}
              autoComplete="email"
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className={styles.input}
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className={styles.btnPrimary} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className={styles.links}>
          <Link to="/forgot" className={styles.link}>Forgot password?</Link>
          <span className={styles.divider}>·</span>
          <Link to="/signup" className={styles.link}>Request access</Link>
        </div>
      </div>
    </div>
  )
}

function friendlyError(msg = '') {
  if (msg.includes('NotAuthorizedException') || msg.includes('Incorrect username or password'))
    return 'Incorrect email or password.'
  if (msg.includes('UserNotFoundException'))
    return 'No account found with this email.'
  if (msg.includes('UserNotConfirmedException'))
    return 'Please verify your email before signing in.'
  return msg || 'Sign in failed. Please try again.'
}
