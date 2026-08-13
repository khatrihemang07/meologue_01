// Ambient declaration for Vite's `?raw` import suffix, which loads a
// file's contents as a plain string at build time. Scoped to `.sql` rather
// than pulling in `vite/client`'s full ambient type set (this package
// isn't itself a Vite project) since it's the only raw import this package
// makes — see ./migrations/index.ts.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
