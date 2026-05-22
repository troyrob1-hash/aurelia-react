import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import LoginPage         from '@/routes/auth/LoginPage'
import RequestAccessPage from '@/routes/auth/RequestAccessPage'
import ForgotPage        from '@/routes/auth/ForgotPage'
import { lazy, Suspense } from 'react'
import AppShell from '@/components/layout/AppShell'
import { LocationProvider } from '@/store/LocationContext'
import { PeriodProvider } from '@/store/PeriodContext'
import { ToastProvider } from '@/components/ui/Toast'
import OfflineBanner from '@/components/ui/OfflineBanner'
import LoadingScreen from '@/components/ui/LoadingScreen'
const Dashboard   = lazy(() => import('@/routes/Dashboard'))
const OrderHub    = lazy(() => import('@/routes/OrderHub'))
const Inventory   = lazy(() => import('@/routes/Inventory'))
const WeeklySales = lazy(() => import('@/routes/WeeklySales'))
const WasteLog    = lazy(() => import('@/routes/WasteLog'))
const Purchasing  = lazy(() => import('@/routes/Purchasing'))
const Budgets     = lazy(() => import('@/routes/Budgets'))
const Transfers   = lazy(() => import('@/routes/Transfers'))
const LaborPlanner = lazy(() => import('@/routes/LaborPlanner'))
const Settings    = lazy(() => import('@/routes/Settings'))
const Home = lazy(() => import('@/routes/Home'))
function PendingApproval() {
  const { user, clearAuth } = useAuthStore()
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#fafbfc',padding:20}}>
      <div style={{background:'#fff',borderRadius:16,padding:40,maxWidth:420,width:'100%',boxShadow:'0 8px 40px rgba(0,0,0,0.08)',textAlign:'center'}}>
        <div style={{width:48,height:48,borderRadius:'50%',background:'#F15D3B',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px'}}>
          <svg width="24" height="24" viewBox="0 0 32 32"><path d="M16 6 L26 27 L21 27 L19 22.5 L13 22.5 L11 27 L6 27 Z M14.3 18.5 L17.7 18.5 L16 14.8 Z" fill="#fff"/></svg>
        </div>
        <h2 style={{fontSize:20,fontWeight:700,color:'#0f172a',margin:'0 0 8px'}}>Account pending approval</h2>
        <p style={{fontSize:14,color:'#64748b',lineHeight:1.6,margin:'0 0 24px'}}>
          Hi {user?.name || 'there'}. Your account is awaiting admin approval. You'll receive an email once your access has been configured with the right locations and permissions.
        </p>
        <button onClick={() => clearAuth()} style={{padding:'10px 24px',fontSize:14,fontWeight:600,background:'#f1f5f9',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:8,cursor:'pointer'}}>
          Sign out
        </button>
      </div>
    </div>
  )
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  // Block pending/viewer users — they need admin approval first
  const role = user.role?.toLowerCase() || 'viewer'
  if (role === 'viewer' || role === 'pending') return <PendingApproval />
  return children
}
function PublicRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return <LoadingScreen />
  if (user) return <Navigate to="/" replace />
  return children
}
export default 
function AdminOnly({ children }) {
  const { user } = useAuthStore()
  if (/^(admin)$/i.test(user?.role || '')) return children
  return <Navigate to="/" replace />
}

function App() {
  const init = useAuthStore(s => s.init)
  useEffect(() => { init() }, [init])
  return (
    <ToastProvider>
      <OfflineBanner />
      <Routes>
        <Route path="/login"  element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/signup" element={<PublicRoute><RequestAccessPage /></PublicRoute>} />
        <Route path="/request-access" element={<PublicRoute><RequestAccessPage /></PublicRoute>} />
        <Route path="/forgot" element={<PublicRoute><ForgotPage /></PublicRoute>} />
        <Route path="/" element={
          <ProtectedRoute>
            <PeriodProvider>
            <LocationProvider>
              <AppShell />
            </LocationProvider>
            </PeriodProvider>
          </ProtectedRoute>
        }>
         <Route index element={<Suspense fallback={<LoadingScreen />}><Home /></Suspense>} />
          <Route path="dashboard" element={<Suspense fallback={<LoadingScreen />}><Dashboard /></Suspense>} />
          <Route path="orders"    element={<Suspense fallback={<LoadingScreen />}><OrderHub /></Suspense>} />
          <Route path="inventory" element={<Suspense fallback={<LoadingScreen />}><Inventory /></Suspense>} />
          <Route path="sales"     element={<Suspense fallback={<LoadingScreen />}><WeeklySales /></Suspense>} />
          <Route path="waste"     element={<Suspense fallback={<LoadingScreen />}><WasteLog /></Suspense>} />
          <Route path="purchasing" element={<Suspense fallback={<LoadingScreen />}><Purchasing /></Suspense>} />
          <Route path="budgets"   element={<Suspense fallback={<LoadingScreen />}><Budgets /></Suspense>} />
          <Route path="transfers" element={<Suspense fallback={<LoadingScreen />}><Transfers /></Suspense>} />
          <Route path="labor"     element={<Suspense fallback={<LoadingScreen />}><LaborPlanner /></Suspense>} />
          <Route path="settings"  element={<Suspense fallback={<LoadingScreen />}>{/^(admin|director)$/i.test(useAuthStore.getState().user?.role || '') ? <Settings /> : <Navigate to="/" replace />}</Suspense>} />
          <Route path="*"         element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}