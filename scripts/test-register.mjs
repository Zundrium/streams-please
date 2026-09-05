import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileModule } from 'svelte/compiler';

const lib = new URL('../src/lib/', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('$lib/')) specifier = new URL(specifier.slice(5), lib).href;
    if (specifier.startsWith('.') || specifier.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      for (const candidate of [url.href, `${url.href}.ts`, `${url.href}/index.ts`]) {
        if (existsSync(new URL(candidate)) && /\.(?:ts|mjs|js)$/.test(candidate)) {
          return nextResolve(candidate, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.svelte.ts')) {
      const source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'));
      return {
        format: 'module',
        source: compileModule(source, { filename: fileURLToPath(url), generate: 'client' }).js.code,
        shortCircuit: true
      };
    }
    return nextLoad(url, context);
  }
});
