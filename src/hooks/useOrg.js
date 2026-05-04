import { useAuthStore } from '@/store/authStore'

export function useOrg() {
  const user = useAuthStore(s => s.user)
  const orgId = user?.tenantId || null
  return { orgId, orgReady: !!orgId }
}
