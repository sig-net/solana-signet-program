import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['./index.ts'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  clean: true,
  dts: false,
  external: [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ],
});
