import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { signIn, getUser, completeNewPassword } from '@/lib/auth'
import { useAuthStore } from '@/store/authStore'
import styles from './Auth.module.css'


function ProductPreview() {
  return (
    <div style={{padding:'0 24px',position:'relative',zIndex:1}}>
      <div style={{maxWidth:1100,margin:'0 auto',background:'#111827',borderRadius:16,border:'1px solid rgba(255,255,255,0.06)',borderBottom:'none',padding:'20px 20px 0',overflow:'hidden'}}>

        <div style={{display:'flex',gap:10,marginBottom:16}}>
          {[{l:'Total GFS',v:'$210,451',d:'+3.2% vs budget',bg:'#F15D3B',dc:'rgba(255,255,255,0.7)'},
            {l:'Net revenue',v:'$62,279',d:'On track',bg:'#162033',dc:'#5DCAA5'},
            {l:'EBITDA',v:'$18,420',d:'-1.8% vs budget',bg:'#162033',dc:'#F0997B'},
            {l:'Prime cost',v:'67.2%',d:'Under target',bg:'#162033',dc:'#5DCAA5'}].map((c,i)=>(
            <div key={i} style={{background:c.bg,borderRadius:8,padding:'14px 16px',flex:1}}>
              <div style={{fontSize:10,color:'rgba(255,255,255,0.5)',marginBottom:4}}>{c.l}</div>
              <div style={{fontSize:24,fontWeight:700,color:'#fff',letterSpacing:'-0.5px'}}>{c.v}</div>
              <div style={{fontSize:11,color:c.dc,marginTop:3}}>{c.d}</div>
            </div>
          ))}
        </div>

        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:12}}>
          <div style={{background:'#0d1420',borderRadius:10,padding:'14px 16px'}}>
            <div style={{fontSize:13,fontWeight:600,color:'#e2e8f0',marginBottom:12}}>P&L — Period 3, Week 3</div>
            {[{l:'Popup GFS',v:'$162,920',d:'+4.1%',dc:'#5DCAA5'},
              {l:'Catering GFS',v:'$31,625',d:'-2.3%',dc:'#F0997B'},
              {l:'On-site labor',v:'$28,429',d:'13.5% of GFS',dc:'#e2e8f0'},
              {l:'Food purchases',v:'$89,240',d:'42.4%',dc:'#e2e8f0'},
              {l:'Shrinkage',v:'$1,240',d:'0.6%',dc:'#F09595'}].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:i<4?'0.5px solid rgba(255,255,255,0.04)':'none'}}>
                <span style={{fontSize:13,color:'#4a5578'}}>{r.l}</span>
                <span style={{fontSize:13,color:'#e2e8f0',fontWeight:500}}>{r.v}</span>
                <span style={{fontSize:12,color:r.dc}}>{r.d}</span>
              </div>
            ))}
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {[{n:'Downtown Kitchen',v:'$42,180',d:'+4.1%',c:'#1D9E75'},
              {n:'Midtown Cafe',v:'$38,920',d:'-2.8%',c:'#dc2626'},
              {n:'Harbor Bistro',v:'$35,600',d:'+1.2%',c:'#1D9E75'},
              {n:'Parkside Grill',v:'$29,450',d:'+0.4%',c:'#1D9E75'}].map((l,i)=>(
              <div key={i} style={{background:'#0d1420',borderRadius:'0 10px 10px 0',padding:'12px 14px',borderLeft:'3px solid '+l.c,flex:1}}>
                <div style={{fontSize:11,color:'#4a5578'}}>{l.n}</div>
                <div style={{fontSize:18,fontWeight:700,color:'#fff',letterSpacing:'-0.5px'}}>{l.v}</div>
                <div style={{fontSize:11,color:l.c,fontWeight:500}}>{l.d} vs budget</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}

export default function LoginPage() {
  const locState = useLocation().state || {}
  const [step, setStep]           = useState(locState.challenge === 'new_password' ? 'new_password' : 'login')
  const [email, setEmail]         = useState(locState.email || '')
  const [pw, setPw]               = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [session, setSession]     = useState(locState.session || null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [showLogin, setShowLogin] = useState(false)
  const [scrolled, setScrolled]   = useState(false)

  const { setAuth } = useAuthStore()
  const nav = useNavigate()

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 80)
    window.addEventListener('scroll', fn)
    return () => window.removeEventListener('scroll', fn)
  }, [])

  async function handleLogin(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const r = await signIn(email.trim(), pw)
      if (r.type === 'new_password') { setSession(r.session); setStep('new_password'); setShowLogin(false); setLoading(false); return }
      const a = await getUser(r.session.accessToken); setAuth(r.session, a); nav('/')
    } catch (err) { setError(friendly(err.message)) } finally { setLoading(false) }
  }

  async function handleNewPw(e) {
    e.preventDefault(); setError('')
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return }
    if (newPw.length < 8) { setError('Min 8 characters.'); return }
    setLoading(true)
    try { const s = await completeNewPassword(email.trim(), newPw, session); const a = await getUser(s.accessToken); setAuth(s, a); nav('/') }
    catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  if (step === 'new_password') return (
    <div className={styles.page}><div className={styles.card}>
      <div className={styles.logo}><div className={styles.logoBox}><svg width="22" height="22" viewBox="0 0 32 32"><path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#fff"/></svg></div>
      <div><div className={styles.appName}>Aurelia</div><div className={styles.appSub}>Operations Management Suite</div></div></div>
      <h1 className={styles.heading}>Set your password</h1>
      <p style={{color:'#64748b',fontSize:13,marginBottom:16}}>Welcome! Create a password to continue.</p>
      {error && <div className={styles.error}>{error}</div>}
      <form onSubmit={handleNewPw} className={styles.form}>
        <div className={styles.field}><label className={styles.label}>New password</label><input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} placeholder="Min 8 characters" className={styles.input} required autoFocus/></div>
        <div className={styles.field}><label className={styles.label}>Confirm</label><input type="password" value={confirmPw} onChange={e=>setConfirmPw(e.target.value)} placeholder="Repeat password" className={styles.input} required/></div>
        <button type="submit" className={styles.btnPrimary} disabled={loading}>{loading ? 'Setting...' : 'Set password & sign in'}</button>
      </form>
    </div></div>
  )

  return (
    <div className={styles.landing}>
      {/* Nav */}
      <nav className={`${styles.nav} ${scrolled ? styles.navScrolled : ''}`}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:30,height:30,borderRadius:'50%',background:'#F15D3B',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <svg width="15" height="15" viewBox="0 0 32 32"><path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#fff"/></svg>
          </div>
          <span style={{fontSize:16,fontWeight:800,color:'#F15D3B',letterSpacing:'-0.4px'}}>Aurelia</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:16}}>
          <Link to="/request-access" style={{fontSize:13,color:'#64748b',textDecoration:'none'}}>Request access</Link>
          <button className={styles.navSignIn} onClick={()=>setShowLogin(true)}>Sign in</button>
        </div>
      </nav>

      {/* Login overlay */}
      {showLogin && (
        <div className={styles.loginOverlay} onClick={e => e.target === e.currentTarget && setShowLogin(false)}>
          <div className={styles.loginCard}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <div>
                <div style={{fontSize:18,fontWeight:700,color:'#0f172a'}}>Sign in</div>
                <div style={{fontSize:13,color:'#64748b'}}>Welcome back</div>
              </div>
              <button onClick={()=>setShowLogin(false)} style={{background:'none',border:'none',fontSize:20,color:'#94a3b8',cursor:'pointer',padding:0}}>&#x2715;</button>
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <form onSubmit={handleLogin} className={styles.form}>
              <div className={styles.field}><label className={styles.label}>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com" className={styles.input} autoComplete="email" required autoFocus/></div>
              <div className={styles.field}><label className={styles.label}>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Enter password" className={styles.input} autoComplete="current-password" required/></div>
              <div style={{textAlign:'right'}}><Link to="/forgot" style={{fontSize:12,color:'#F15D3B',textDecoration:'none'}}>Forgot password?</Link></div>
              <button type="submit" className={styles.btnPrimary} disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
            </form>
            <div style={{textAlign:'center',marginTop:16,fontSize:13,color:'#94a3b8'}}>
              No account? <Link to="/request-access" style={{color:'#F15D3B',textDecoration:'none',fontWeight:600}}>Request access</Link>
            </div>
          </div>
        </div>
      )}

      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroGlow}/>
        <div className={styles.heroGlow2}/>
        <div style={{position:'relative',zIndex:1,textAlign:'center',width:'100%'}}>
          <div style={{fontSize:44,fontWeight:800,color:'#0f172a',letterSpacing:'-1.5px',lineHeight:1.1,marginBottom:16}}>From order to P&L.<br/><span style={{color:'#F15D3B'}}>Automatically.</span></div>
          <div style={{fontSize:17,color:'#64748b',lineHeight:1.6,maxWidth:460,margin:'0 auto 32px'}}>
            Inventory, ordering, purchasing, and P&L — unified across every location. Built for restaurant operators who are done with spreadsheets.
          </div>
          <div style={{display:'flex',gap:12,justifyContent:'center'}}>
            <button className={styles.btnHero} onClick={()=>setShowLogin(true)}>Get started</button>
            <Link to="/request-access" className={styles.btnHeroOutline} style={{color:'#64748b',borderColor:'#d1d5db'}}>Request a demo</Link>
          </div>
        </div>
      </div>

      {/* Product walkthrough */}
      <ProductPreview />

      {/* Footer CTA */}
      <div className={styles.footer} style={{marginTop:80,borderRadius:'24px 24px 0 0'}}>
        <div style={{fontSize:36,fontWeight:800,color:'#fff',letterSpacing:'-1px',lineHeight:1.15,marginBottom:12}}>Ready to see it live?</div>
        <div style={{fontSize:16,color:'#94a3b8',marginBottom:32}}>Request a demo or sign in to your account.</div>
        <div style={{display:'flex',gap:16,justifyContent:'center'}}>
          <button className={styles.btnHero} onClick={()=>{window.scrollTo({top:0,behavior:'smooth'});setTimeout(()=>setShowLogin(true),500)}}>Sign in</button>
          <Link to="/request-access" className={styles.btnHeroOutline} style={{color:'#64748b',borderColor:'#d1d5db'}}>Request a demo</Link>
        </div>
      </div>
    </div>
  )
}

function friendly(msg='') {
  if (msg.includes('NotAuthorizedException') || msg.includes('Incorrect username or password')) return 'Incorrect email or password.'
  if (msg.includes('UserNotFoundException')) return 'No account found with this email.'
  if (msg.includes('UserNotConfirmedException')) return 'Please verify your email first.'
  return msg || 'Sign in failed. Please try again.'
}
