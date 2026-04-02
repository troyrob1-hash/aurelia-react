// src/hooks/useAuth.js
// Thin wrapper around useAuthStore that adds orgId
// orgId maps to the user's tenantId (custom:tenantId in Cognito)

import { useAuthStore } from '@/store/authStore'

export function useAuth() {
  const { user, session, loading } = useAuthStore()

  return {
    user,
    session,
    loading,
    orgId: user?.tenantId ?? null,
  }
}