import { useEffect, useRef, useState } from 'react'
import { isEditable, overlayOpen } from '../useTypeAnywhere'

export function OtpInput({ length = 6, onComplete, onChange, disabled }) {
  const [vals, setVals] = useState(() => Array(length).fill(''))
  const refs = useRef([])

  const commit = next => {
    setVals(next)
    const code = next.join('')
    onChange?.(code)
    if (code.length === length && next.every(v => v !== '')) onComplete?.(code)
  }

  const handleInput = (i, e) => {
    const v = e.target.value.replace(/\D/g, '').slice(-1)
    const next = [...vals]
    next[i] = v
    commit(next)
    if (v && i < length - 1) refs.current[i + 1]?.focus()
  }

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !vals[i] && i > 0) refs.current[i - 1]?.focus()
  }

  const fillFrom = text => {
    const digits = (text || '').replace(/\D/g, '').slice(0, length)
    if (!digits) return false
    const next = Array(length).fill('')
    digits.split('').forEach((d, j) => { next[j] = d })
    commit(next)
    refs.current[Math.min(digits.length, length - 1)]?.focus()
    return true
  }

  const handlePaste = e => {
    e.preventDefault()
    fillFrom(e.clipboardData.getData('text'))
  }

  // Type-anywhere (see useTypeAnywhere.js): a digit typed with nothing focused
  // lands in the first empty box, and a code pasted anywhere fills the row —
  // the page has exactly one thing to type into, so nothing needs clicking.
  useEffect(() => {
    if (disabled) return undefined
    const own = el => refs.current.includes(el)
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!/^\d$/.test(e.key)) return
      if (own(document.activeElement)) return
      if (isEditable(document.activeElement) || overlayOpen()) return
      const idx = vals.findIndex(v => v === '')
      refs.current[idx === -1 ? length - 1 : idx]?.focus()
    }
    const onPaste = e => {
      if (own(e.target)) return
      if (isEditable(e.target) || overlayOpen()) return
      if (fillFrom(e.clipboardData?.getData('text'))) e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('paste', onPaste)
    }
  })

  return (
    <div className="otp">
      {vals.map((v, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el }}
          inputMode="numeric"
          maxLength={1}
          aria-label={`digit ${i + 1}`}
          value={v}
          disabled={disabled}
          onChange={e => handleInput(i, e)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={handlePaste}
        />
      ))}
    </div>
  )
}
