import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.mjs'],
        // The compiled contract ships a sourcemap whose `sources` are relative
        // to the repo root, not to the emitted file. Vite resolves them
        // relative to the file and warns. Loading the compiled artifact
        // externally skips Vite's transform, which is what we want anyway: the
        // tests should exercise the compiler's output exactly as published,
        // not a re-transformed copy of it.
        server: { deps: { external: [/managed[\\/]/] } }
    }
});
