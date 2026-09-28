import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { forgotPassword, friendlyAuthError } from '@/lib/auth'
import styles from './Auth.module.css'

/**
 * CUTOVER 2026-09-28 (Cognito → Firebase Auth): this page used to be two steps
 * — Cognito emailed a 6-digit code, the user typed it back here along with a
 * new password, and `confirmForgotPassword` verified both.
 *
 * Firebase instead emails a signed reset link and hosts the reset page itself,
 * so the app never sees a code and never handles the new password. The second
 * step (code + new password fields) is therefore gone, not relocated.
 *
 * This is also the path every migrated user takes to set their first Firebase
 * password — Cognito's password hashes did not (and could not) come across.
 */
export default function ForgotPage() {
  const [step, setStep]           = useState('email')
  const [email, setEmail]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [resending, setResending] = useState(false)
  const [cooldown, setCooldown]   = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  async function send(addr) {
    // Deliberately not surfacing auth/user-not-found: on an unauthenticated
    // form that is an account-enumeration oracle. The user sees the same
    // confirmation whether or not the address is on file.
    try {
      await forgotPassword(addr)
    } catch (err) {
      if (err?.code === 'auth/user-not-found') return
      throw err
    }
  }

  async function handleSend(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      await send(email.trim().toLowerCase())
      setStep('sent')
      setCooldown(30)
    } catch (err) {
      setError(friendlyAuthError(err))
    } finally { setLoading(false) }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return
    setError(''); setResending(true)
    try {
      await send(email.trim().toLowerCase())
      setCooldown(30)
    } catch (err) {
      setError(friendlyAuthError(err))
    } finally { setResending(false) }
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

        {step === 'sent' ? (
          <>
            <h1 className={styles.heading}>Check your email</h1>
            <div className={styles.success}>
              If an account exists for {email}, a password reset link has been sent.
            </div>
            {/* Deliberately not promising arrival — see the delivery notice on
                the email step. Mail filtering is the likely outcome, so the
                admin route is named up front rather than buried after a wait. */}
            <div className={styles.info} style={{ margin: '14px 0' }}>
              If it doesn't arrive within a few minutes, it has most likely been caught by
              Fooda's mail filter — <strong>ask your admin for a one-time reset link</strong>
              rather than waiting.
            </div>
            <div style={{color:'#6b7280',fontSize:12,margin:'16px 0',lineHeight:1.5}}>
              Open the link to set a new password, then sign in. You can also{' '}
              <button
                type="button"
                onClick={handleResend}
                disabled={cooldown > 0 || resending}
                style={{
                  background:'none',
                  border:'none',
                  padding:0,
                  font:'inherit',
                  color: (cooldown > 0 || resending) ? '#9ca3af' : '#F15D3B',
                  cursor: (cooldown > 0 || resending) ? 'default' : 'pointer',
                  textDecoration:'underline',
                }}
              >
                {resending ? 'resending…' : cooldown > 0 ? `resend in ${cooldown}s` : 'send it again'}
              </button>
              , and it's worth checking your spam folder.
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <Link to="/login" className={styles.btnPrimary} style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              Back to Sign In
            </Link>
          </>
        ) : (
          <>
            <h1 className={styles.heading}>Reset password</h1>
            {/* Delivery notice (2026-09-28). The reset MECHANISM works — it was
                verified end-to-end — but Fooda's M365/EOP gateway quarantines
                mail from Firebase's default sender, and aurelia.com has no MX
                records at all, so for most users nothing arrives. Leading with
                that is the difference between a user who knows to ask their
                admin and a user stranded on "check your email".
                The form below is intentionally left working: it needs no code
                change to come good the moment a custom SMTP sender is
                configured, and it may already work for other domains.
                Delete this block once delivery is fixed. */}
            <div className={styles.info} style={{ marginBottom: 14 }}>
              Password reset emails are not reliably reaching Fooda addresses right now.
              The fastest way in is to <strong>ask your admin for a one-time reset link</strong>.
              You can still try email below.
            </div>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 20 }}>
              Enter your email and we'll try to send you a link to set a new password.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <form onSubmit={handleSend} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@fooda.com" className={styles.input} required autoFocus />
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={loading}>
                {loading ? 'Sending...' : 'Send Reset Link'}
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
