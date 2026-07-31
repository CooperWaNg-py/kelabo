// The variant seam (overlay point).
//
// Default builds resolve `@kelabo/variant` to this file, so the app you can
// read is the app you get. An overlay build can alias `@kelabo/variant` to its
// own module with the same exports, swapping pages or adding routes at build
// time — the direction of dependency never reverses: nothing in this repo
// knows an overlay exists.
//
// Exports:
//   Login       — the sign-in page component.
//   extraRoutes — [{ path, element }] appended inside <Routes> (empty here).
export { default as Login } from './routes/Login'
export const extraRoutes = []
