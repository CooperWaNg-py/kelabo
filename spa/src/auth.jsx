import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from './api'
import { pullSettings } from './settings'

const AuthContext = createContext({ identity: null, tenantId: null, loading: true, refresh: () => {} })

export function AuthProvider({ children }) {
  const [identity, setIdentity] = useState(null)
  const [tenantId, setTenantId] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const me = await api.me()
      setIdentity(me?.identity || null)
      setTenantId(me.tenantId || null)
    } catch (e) {
      if (e.status === 401) {
        try {
          await api.refresh()
          const me = await api.me()
          setIdentity(me?.identity || null)
          setTenantId(me.tenantId || null)
        } catch {
          setIdentity(null)
          setTenantId(null)
        }
      } else {
        setIdentity(null)
        setTenantId(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!identity) return undefined
    // Cross-device settings sync: pull once per sign-in; the backend snapshot
    // wins when newer than the local one.
    pullSettings()
    const t = setInterval(() => { api.refresh().catch(() => {}) }, 45 * 60 * 1000)
    return () => clearInterval(t)
  }, [identity])

  return (
    <AuthContext.Provider value={{ identity, tenantId, loading, refresh: load }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export function displayName(identity) {
  if (!identity) return null
  return identity.displayName || (identity.email ? identity.email.split('@')[0] : null)
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/[\s.@_-]+/).filter(Boolean)
  const s = (parts[0]?.[0] || '?') + (parts[1]?.[0] || '')
  return s.toUpperCase()
}
