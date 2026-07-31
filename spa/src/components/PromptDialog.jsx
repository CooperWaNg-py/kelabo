import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Modal } from './ui/Modal'

const PromptContext = createContext(() => Promise.resolve(null))

export function PromptProvider({ children }) {
  const [state, setState] = useState(null)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  const prompt = useCallback(opts => {
    return new Promise(resolve => {
      setState({
        title: '',
        placeholder: '',
        initialValue: '',
        confirmLabel: 'Save',
        cancelLabel: 'Cancel',
        ...opts,
        resolve,
      })
      setValue(opts?.initialValue ?? '')
    })
  }, [])

  useEffect(() => {
    if (!state) return undefined
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [state])

  const done = val => {
    state?.resolve(val)
    setState(null)
  }

  const submit = e => {
    e?.preventDefault()
    const v = value.trim()
    done(v || null)
  }

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Modal
        open={!!state}
        onDismiss={() => done(null)}
        label={state?.title}
        as="form"
        onSubmit={submit}
        badge={<span className="modal-icon modal-icon-neutral"><Icon name={state?.icon || 'pencil'} /></span>}
        title={state?.title}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => done(null)}>{state?.cancelLabel}</Button>
            <Button type="submit" variant="primary">{state?.confirmLabel}</Button>
          </>
        }
      >
        <input
          ref={inputRef}
          className="input modal-input"
          value={value}
          placeholder={state?.placeholder}
          onChange={e => setValue(e.target.value)}
          aria-label={state?.title}
        />
      </Modal>
    </PromptContext.Provider>
  )
}

export function usePrompt() {
  return useContext(PromptContext)
}
