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
function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  return children
}
function PublicRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return <LoadingScreen />
  if (user) return <Navigate to="/" replace />
  return children
}
export default function App() {
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
          <Route path="settings"  element={<Suspense fallback={<LoadingScreen />}><Settings /></Suspense>} />
          <Route path="*"         element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}