import { useState } from 'react'
import { Link } from 'react-router-dom'
import { signUp, confirmSignUp } from '@/lib/auth'
import styles from './Auth.module.css'

export default function SignUpPage() {
  const [step, setStep]         = useState('form') // form | verify | done
  const [name, setName]         = useState('')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [code, setCode]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  async function handleSignUp(e) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    try {
      await signUp(email.trim().toLowerCase(), password, name.trim())
      setStep('verify')
    } catch (err) {
      setError(err.message.includes('UsernameExistsException')
        ? 'An account with this email already exists.'
        : err.message)
    } finally { setLoading(false) }
  }

  async function handleVerify(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await confirmSignUp(email.trim().toLowerCase(), code.trim())
      setStep('done')
    } catch (err) {
      setError(err.message.includes('CodeMismatchException')
        ? 'Invalid code. Please try again.'
        : err.message)
    } finally { setLoading(false) }
  }

  if (step === 'done') {
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
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Account Created!</h2>
            <p style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.6 }}>
              Your email has been verified. An administrator will review and approve your access shortly.
            </p>
          </div>
          <Link to="/login" className={styles.btnPrimary} style={{ display: 'block', textAlign: 'center', marginTop: 20 }}>
            Back to Sign In
          </Link>
        </div>
      </div>
    )
  }

  if (step === 'verify') {
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
          <h1 className={styles.heading}>Verify your email</h1>
          <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 20 }}>
            We sent a 6-digit code to <strong>{email}</strong>
          </p>
          {error && <div className={styles.error}>{error}</div>}
          <form onSubmit={handleVerify} className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label}>Verification Code</label>
              <input
                type="text"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="000000"
                maxLength={6}
                className={styles.codeInput}
                autoFocus
                required
              />
            </div>
            <button type="submit" className={styles.btnPrimary} disabled={loading}>
              {loading ? 'Verifying...' : 'Verify Email'}
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
        <h1 className={styles.heading}>Request access</h1>
        {error && <div className={styles.error}>{error}</div>}
        <form onSubmit={handleSignUp} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Full Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Your full name" className={styles.input} required />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@fooda.com" className={styles.input} required />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Min 8 characters" className={styles.input} required />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Confirm Password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat password" className={styles.input} required />
          </div>
          <button type="submit" className={styles.btnPrimary} disabled={loading}>
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>
        <div className={styles.links}>
          <Link to="/login" className={styles.link}>← Back to Sign In</Link>
        </div>
      </div>
    </div>
  )
}
