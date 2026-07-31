import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A shared screen.
 *
 * Its own capture again, for the same reason as the camera: it has a lifecycle
 * of its own. What is different here is that the browser owns the stop button
 * too — Chrome and Firefox put their own "Stop sharing" bar on screen, and a
 * user who presses that has stopped sharing whether or not this app noticed.
 * So `ended` on the track is authoritative, not the app's own state, and the
 * app follows it rather than the other way round.
 *
 * Video only. `getDisplayMedia` can capture system audio, but the kelabo's
 * microphone has echo cancellation tuned against the speakers, and mixing tab
 * audio back into the same call is how you get a feedback loop — worth doing
 * deliberately later, not as a side effect of adding screen share.
 */

export function useScreenShare({ enabled }) {
  const [stream, setStream] = useState(null)
  const [state, setState] = useState('off') // off | requesting | live | denied | unavailable
  const streamRef = useRef(null)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStream(null)
    setState('off')
  }, [])

  // A share cannot outlive the kelabo.
  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  useEffect(() => () => stop(), [stop])

  const start = useCallback(async () => {
    if (!enabled) return
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setState('unavailable')
      return
    }
    setState('requesting')
    let next
    try {
      next = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      })
    } catch (err) {
      // Dismissing the picker throws exactly like a denial does. It is not an
      // error state — the person simply changed their mind — so it must not
      // leave a warning banner up.
      setState(err?.name === 'NotAllowedError' ? 'off' : 'denied')
      return
    }

    // Replacing an existing share: stop the old capture first, or the browser
    // keeps showing its "sharing" indicator for a surface nobody is watching.
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = next
    setStream(next)
    setState('live')

    // The browser's own stop button, the shared window being closed, or the
    // surface disappearing. All of them arrive here.
    const track = next.getVideoTracks()[0]
    track?.addEventListener('ended', () => {
      if (streamRef.current !== next) return
      streamRef.current = null
      setStream(null)
      setState('off')
    }, { once: true })
  }, [enabled])

  const toggle = useCallback(() => {
    if (streamRef.current) stop()
    else start()
  }, [start, stop])

  return {
    on: !!stream,
    stream,
    state,
    start,
    stop,
    toggle,
    error: state === 'denied' || state === 'unavailable' ? state : null,
  }
}
