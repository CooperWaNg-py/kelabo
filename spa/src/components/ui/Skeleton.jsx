export function Skeleton({ className = '' }) {
  return <div className={'skel ' + className} aria-hidden="true"></div>
}

export function SkeletonRows({ n = 3 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }).map((_, i) => (
        <div className="row" key={i}>
          <Skeleton className="skel-dot" />
          <div className="row-main">
            <Skeleton className="skel-title" />
            <Skeleton className="skel-text" />
          </div>
        </div>
      ))}
    </div>
  )
}
