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
            <div className={styles.logoBox} style={{background:'#0f172a',borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',position:'relative',padding:0,width:48,height:48}}>
              <svg width="48" height="48" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'absolute',top:0,left:0}}>
                <circle cx="16" cy="16" r="14" fill="none" stroke="#F15D3B" strokeWidth="2"/>
                <circle cx="16" cy="16" r="11" fill="none" stroke="#F15D3B" strokeWidth="1" opacity="0.5"/>
              </svg>
              <svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'relative',zIndex:1}}>
                <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#ffffff"/>
              </svg>
            </div>
            <div>
              <div className={styles.appName}>Aurelia</div>
              <div className={styles.appSub}>Operations Management Suite</div>
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
          <div className={styles.logoBox} style={{background:'#0f172a',borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',position:'relative',padding:0,width:48,height:48}}>
            <svg width="48" height="48" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'absolute',top:0,left:0}}>
              <circle cx="16" cy="16" r="14" fill="none" stroke="#F15D3B" strokeWidth="2"/>
              <circle cx="16" cy="16" r="11" fill="none" stroke="#F15D3B" strokeWidth="1" opacity="0.5"/>
            </svg>
            <svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style={{position:'relative',zIndex:1}}>
              <path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#ffffff"/>
            </svg>
          </div>
          <div>
            <div className={styles.appName}>Aurelia</div>
            <div className={styles.appSub}>Operations Management Suite</div>
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