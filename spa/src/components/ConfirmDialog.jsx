import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Modal } from './ui/Modal'

const ConfirmContext = createContext(() => Promise.resolve(false))

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const okRef = useRef(null)

  const confirm = useCallback(opts => {
    return new Promise(resolve => {
      setState({
        // an <Icon> name, not a literal glyph
        icon: 'alert',
        confirmLabel: 'Confirm',
        cancelLabel: 'Cancel',
        danger: true,
        ...opts,
        resolve,
      })
    })
  }, [])

  useEffect(() => {
    if (!state) return undefined
    okRef.current?.focus()
  }, [state])

  const done = val => {
    state?.resolve(val)
    setState(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onDismiss={() => done(false)}
        label={state?.title}
        badge={
          /* The red badge is reserved for the destructive ones. A dialog
             that only wants a yes/no ("leave this kelabo?") wearing the
             same alarm colour as "delete permanently" makes the colour
             stop meaning anything. */
          <span className={'modal-icon' + (state?.danger ? '' : ' modal-icon-neutral')}>
            <Icon name={state?.icon} />
          </span>
        }
        title={state?.title}
        actions={
          <>
            <Button variant="ghost" onClick={() => done(false)}>{state?.cancelLabel}</Button>
            <Button
              ref={okRef}
              variant={state?.danger ? 'danger' : 'primary'}
              onClick={() => done(true)}
            >
              {state?.confirmLabel}
            </Button>
          </>
        }
      >
        <p className="modal-body">{state?.body}</p>
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
