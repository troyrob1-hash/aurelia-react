import { useState } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { signIn, getUser, completeNewPassword } from '@/lib/auth'
import { useAuthStore } from '@/store/authStore'
import styles from './Auth.module.css'

export default function LoginPage() {
  const locationState = useLocation().state || {}
  const [step, setStep]         = useState(locationState.challenge === 'new_password' ? 'new_password' : 'login')
  const [email, setEmail]       = useState(locationState.email || '')
  const [password, setPassword] = useState('')
  const [newPw, setNewPw]       = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [session, setSession]   = useState(locationState.session || null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  const { setAuth } = useAuthStore()
  const navigate    = useNavigate()

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await signIn(email.trim().toLowerCase(), password)
      if (result.type === 'new_password') {
        setSession(result.session)
        setStep('new_password')
        setLoading(false)
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

  async function handleNewPassword(e) {
    e.preventDefault()
    setError('')
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return }
    if (newPw.length < 8)   { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    try {
      const sess = await completeNewPassword(email.trim().toLowerCase(), newPw, session)
      const attrs = await getUser(sess.accessToken)
      setAuth(sess, attrs)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (step === 'new_password') {
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
          <h1 className={styles.heading}>Set your password</h1>
          <p style={{color:'#6b7280',fontSize:13,marginBottom:20}}>
            Welcome! Please set a new password for your account.
          </p>
          {error && <div className={styles.error}>{error}</div>}
          <form onSubmit={handleNewPassword} className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label}>New Password</label>
              <input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)}
                placeholder="Min 8 characters" className={styles.input} required autoFocus/>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Confirm Password</label>
              <input type="password" value={confirmPw} onChange={e=>setConfirmPw(e.target.value)}
                placeholder="Repeat password" className={styles.input} required/>
            </div>
            <button type="submit" className={styles.btnPrimary} disabled={loading}>
              {loading ? 'Setting password...' : 'Set Password & Sign In'}
            </button>
          </form>
        </div>
      </div>
    )
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
        <form onSubmit={handleLogin} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="you@fooda.com" className={styles.input} autoComplete="email" required/>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
              placeholder="••••••••" className={styles.input} autoComplete="current-password" required/>
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
