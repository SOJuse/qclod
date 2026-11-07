/**
 * A dynamic import the bundler cannot rewrite.
 *
 * The main process is bundled as CommonJS, and a bundler turns `import()` into
 * `require()` — which cannot load an ES module. The Agent SDK is ESM only, so
 * loading it the ordinary way fails at runtime in a packaged build with
 * «require() of ES Module … not supported», while every automated test passes,
 * because the tests inject a fixture and never load the real SDK at all.
 *
 * Building the import through `Function` keeps it a real dynamic import: the
 * bundler sees a string, not an import.
 */
export function importEsm<T>(specifier: string): Promise<T> {
  const load = new Function('s', 'return import(s)') as (s: string) => Promise<T>
  return load(specifier)
}
