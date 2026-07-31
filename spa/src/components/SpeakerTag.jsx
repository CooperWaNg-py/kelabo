export function speakerClass(name) {
  const s = String(name || '?')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return 'sp-' + ((h % 5) + 1)
}

export function SpeakerTag({ name }) {
  // `title` matters here: in the transcript the name sits in a fixed-width
  // gutter and truncates, so this is the only way to read a long one in full.
  return <span className={'speaker ' + speakerClass(name)} title={name}>{name}</span>
}
