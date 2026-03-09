# Captioner Desktop

Tauri + React (Bun + Vite) desktop app for scanning image folders, previewing images, and generating captions via LM Studio-compatible API. The UI uses Mantine for a desktop-style three-column layout with internal scrolling panels.

## Features
- Directory scan with summary counts (total / captioned / pending)
- Prompt preset management (system + user prompts, create/duplicate/delete)
- API settings (base URL, optional API key, model, concurrency, retry, timeout)
- Image list with list/grid modes and square thumbnails
- Preview & caption editor with save
- Batch generation with per-image status

## Tech Stack
- Frontend: React, Mantine, Vite, Bun
- Desktop shell: Tauri (Rust backend)
- API: LM Studio `/v1/responses` compatible

## Development
```bash
# install frontend deps
cd desktop
bun install

# run dev (tauri)
bun run tauri:dev

# build frontend
bun run build

# run backend tests
cd src-tauri
cargo test
```

## Repository Layout
- `desktop/` — React app + Tauri project
- `docs/` — planning docs

## Notes
- Initial commit pushed to `origin/master`.
- Configure GitHub auth via `gh auth login` if needed for future PRs.

## Release (macOS unsigned via GitHub Actions)
- Create a tag `vX.Y.Z` on `master`/`main` and push:
  ```bash
  git tag v0.1.0
  git push origin v0.1.0
  ```
- GitHub Actions workflow `.github/workflows/release.yml` will build the macOS app (unsigned) and publish a Release with a `.dmg` artifact.
- Install the app from the released `.dmg`. Repackaging or extracting the `.app` separately can cause macOS validation failures.
- Unsigned binaries will trigger Gatekeeper warnings; users may need to right-click Open or allow in Security & Privacy.
