import { useState } from 'react'
import { Link } from 'react-router-dom'
import { forgotPassword, confirmForgotPassword } from '@/lib/auth'
import styles from './Auth.module.css'

export default function ForgotPage() {
  const [step, setStep]           = useState('email')
  const [email, setEmail]         = useState('')
  const [code, setCode]           = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [success, setSuccess]     = useState('')

  async function handleSendCode(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await forgotPassword(email.trim().toLowerCase())
      setStep('reset')
      setSuccess(`Reset code sent to ${email}`)
    } catch (err) {
      setError(err.message)
    } finally { setLoading(false) }
  }

  async function handleReset(e) {
    e.preventDefault()
    setError('')
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return }
    if (newPw.length < 8)   { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    try {
      await confirmForgotPassword(email.trim().toLowerCase(), code.trim(), newPw)
      setStep('done')
    } catch (err) {
      setError(err.message.includes('CodeMismatchException')
        ? 'Invalid reset code.' : err.message)
    } finally { setLoading(false) }
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

        {step === 'done' ? (
          <>
            <h1 className={styles.heading}>Password reset</h1>
            <div className={styles.success}>Password updated successfully. You can now sign in.</div>
            <Link to="/login" className={styles.btnPrimary} style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              Sign In
            </Link>
          </>
        ) : step === 'email' ? (
          <>
            <h1 className={styles.heading}>Reset password</h1>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 20 }}>
              Enter your email and we'll send you a reset code.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <form onSubmit={handleSendCode} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@fooda.com" className={styles.input} required autoFocus />
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={loading}>
                {loading ? 'Sending...' : 'Send Reset Code'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className={styles.heading}>Enter new password</h1>
            {success && <div className={styles.success}>{success}</div>}
            {error   && <div className={styles.error}>{error}</div>}
            <form onSubmit={handleReset} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>Reset Code</label>
                <input type="text" value={code} onChange={e => setCode(e.target.value)}
                  placeholder="000000" maxLength={6} className={styles.codeInput} required autoFocus />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>New Password</label>
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                  placeholder="Min 8 characters" className={styles.input} required />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Confirm Password</label>
                <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                  placeholder="Repeat password" className={styles.input} required />
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={loading}>
                {loading ? 'Resetting...' : 'Reset Password'}
              </button>
            </form>
          </>
        )}

        <div className={styles.links}>
          <Link to="/login" className={styles.link}>← Back to Sign In</Link>
        </div>
      </div>
    </div>
  )
}
