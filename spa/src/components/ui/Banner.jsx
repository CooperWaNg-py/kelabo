export function Banner({ kind = 'warn', children, style }) {
  return (
    <div className={`banner banner-${kind}`} role="alert" style={style}>
      {children}
    </div>
  )
}
