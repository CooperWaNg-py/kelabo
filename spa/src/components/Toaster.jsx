import { createContext, useCallback, useContext, useRef, useState } from 'react'

const ToastContext = createContext(() => {})

let nextId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const toast = useCallback((msg, ms = 2600) => {
    const id = ++nextId
    setToasts(list => [...list, { id, msg, gone: false }])
    setTimeout(() => {
      setToasts(list => list.map(t => (t.id === id ? { ...t, gone: true } : t)))
      setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 320)
    }, ms)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts">
        {toasts.map(t => (
          <div
            key={t.id}
            className="toast"
            role="status"
            style={t.gone ? { opacity: 0, transition: 'opacity .3s' } : undefined}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
