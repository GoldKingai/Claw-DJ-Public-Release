# Contributing to Claw DJ

Thanks for your interest. Claw DJ is a small project; contribution overhead is intentionally light.

## Quick start for contributors

```bash
git clone https://github.com/GoldKingai/Claw-DJ-Public-Release.git
cd Claw-DJ-Public-Release
npm install
cp .env.example .env
# Edit .env — at minimum, set MUSIC_DIRS to a folder of audio files
npm run dev:all
```

`dev:all` starts the Express backend (`tsx watch server/index.ts`) and the Vite dashboard concurrently. The dashboard proxies `/api/*` to the backend; both auto-reload on file changes.

## Project structure

See [README.md](README.md#project-layout). Briefly:

- `server/` — Express + DJ engine + integrations
- `src/` — Lit dashboard (Three.js avatar + decks + library + chat)
- `public/` — static assets (avatar, animations, branding)
- `luxtts/` — optional local TTS server (Python)

## Code style

- **TypeScript** with `strict: true`. No `any` unless you mean it.
- **No comments for what the code does** — well-named identifiers should carry that. Only comment the *why* when it's non-obvious (a hidden constraint, a workaround for a specific bug).
- **Prefer editing existing files** over creating new ones.
- **Don't add error handling for impossible cases.** Validate at system boundaries (HTTP routes, external APIs), trust internal code.
- **No backwards-compatibility shims** unless we have a real external API to preserve. Just change the code.

## Tests

```bash
npm test           # one-shot
npm run test:watch # watch mode
```

Tests live next to the code they cover, in `server/tests/` for backend logic. The browser dashboard is not yet unit-tested — manual smoke testing in Chrome is the current bar.

## Type-check + build

```bash
npm run build      # tsc --noEmit + vite build
```

CI (TODO) will run this on every PR.

## Submitting changes

1. Fork + branch.
2. Make your change. Add tests if you're touching server logic.
3. Run `npm test` and `npm run build`.
4. Open a PR with a clear description of the *why*, not just the *what*.

For larger changes (new mode, new integration), please open an issue first to discuss the shape before sinking time into code.

## Security issues

Please **don't** file a public issue for vulnerabilities. Use GitHub's private Security Advisory feature instead.

## Code of conduct

Be kind. That's it.
