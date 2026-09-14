/** Node ESM resolve hook: Vite-style extensionless `built/manifold` → `.js`. */
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === '../../built/manifold'
    || specifier.endsWith('/built/manifold')
  ) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}
