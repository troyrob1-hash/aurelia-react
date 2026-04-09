import { useState } from 'react'
import { Link } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import styles from './Auth.module.css'

export default function RequestAccessPage() {
  const [name, setName]       = useState('')
  const [email, setEmail]     = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const trimmedName  = name.trim()
    const trimmedEmail = email.trim().toLowerCase()
    const trimmedMsg   = message.trim()

    if (!trimmedName)  { setError('Please enter your name.'); return }
    if (!trimmedEmail) { setError('Please enter your email.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Please enter a valid email address.'); return
    }
    if (trimmedName.length > 100)  { setError('Name is too long.'); return }
    if (trimmedEmail.length > 200) { setError('Email is too long.'); return }
    if (trimmedMsg.length > 1000)  { setError('Message is too long (max 1000 characters).'); return }

    setLoading(true)
    try {
      const submitAccessRequest = httpsCallable(functions, 'submitAccessRequest')
      await submitAccessRequest({
        name:    trimmedName,
        email:   trimmedEmail,
        message: trimmedMsg,
      })
      setSubmitted(true)
    } catch (err) {
      console.error('submitAccessRequest error:', err)
      setError('Something went wrong. Please try again or contact support.')
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
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
          <h1 className={styles.heading}>Request received</h1>
          <p style={{color:'#6b7280',fontSize:13,marginBottom:20,lineHeight:1.5}}>
            Thanks, {name.trim()}. We've received your access request and will be in touch at <strong>{email.trim().toLowerCase()}</strong> shortly.
          </p>
          <div className={styles.links}>
            <Link to="/login" className={styles.link}>Back to sign in</Link>
          </div>
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
        <p style={{color:'#6b7280',fontSize:13,marginBottom:20,lineHeight:1.5}}>
          Tell us a bit about yourself and we'll get back to you to set up your account.
        </p>
        {error && <div className={styles.error}>{error}</div>}
        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Name</label>
            <input type="text" value={name} onChange={e=>setName(e.target.value)}
              placeholder="Jane Smith" className={styles.input} autoComplete="name" required autoFocus/>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="you@company.com" className={styles.input} autoComplete="email" required/>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Message <span style={{color:'#9ca3af',fontWeight:'normal'}}>(optional)</span></label>
            <textarea value={message} onChange={e=>setMessage(e.target.value)}
              placeholder="Tell us about your role and which locations you need access to."
              className={styles.input} rows={4} maxLength={1000}
              style={{resize:'vertical',fontFamily:'inherit'}}/>
          </div>
          <button type="submit" className={styles.btnPrimary} disabled={loading}>
            {loading ? 'Submitting...' : 'Submit Request'}
          </button>
        </form>
        <div className={styles.links}>
          <Link to="/login" className={styles.link}>Already have an account? Sign in</Link>
        </div>
      </div>
    </div>
  )
}