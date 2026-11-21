# nachogoca.com — run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]
set quiet

# Use the Node version from .nvmrc (via nvm) when available, else whatever is on PATH.
node := 'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; nvm use --silent >/dev/null || true; fi;'

portfolio := env_var_or_default("PORTFOLIO", env_var("HOME") / "Photography/Portfolio")

# List all recipes
default:
    @just --list --unsorted

# ---------- setup ----------

# Install dependencies (clean, from package-lock.json)
install:
    {{node}} npm ci

# Show Node/npm versions in use
versions:
    {{node}} echo "node $(node -v) · npm $(npm -v) · $(which node)"

# ---------- develop ----------

# Dev server for nachogoca.com
dev-home:
    {{node}} npm run dev -w apps/home

# Dev server for photo.nachogoca.com
dev-photo:
    {{node}} npm run dev -w apps/photo

# Type-check both apps
check:
    {{node}} npm run check

# Production build of both apps
build:
    {{node}} npm run build

# Build, then serve the production build of the home site
preview-home: build
    {{node}} npm run preview -w apps/home

# Build, then serve the production build of the photo site
preview-photo: build
    {{node}} npm run preview -w apps/photo

# What CI runs: clean install, type-check, build
ci: install check build

# ---------- photos ----------

# Publish Portfolio → R2 + manifest (optionally one series: just publish 2026/03_tromso_norway)
publish only="":
    {{node}} npm run -s publish-photos -- --source "{{portfolio}}" {{ if only != "" { "--only " + only } else { "" } }}

# Show what publish would upload, without uploading or writing the manifest
publish-dry:
    {{node}} npm run -s publish-photos -- --source "{{portfolio}}" --dry-run

# Preview photos locally (no R2): writes local images + manifest, then starts the photo dev server
publish-local:
    {{node}} npm run -s publish-photos -- --source "{{portfolio}}" --target local
    {{node}} npm run dev -w apps/photo

# List R2 objects no longer referenced by the manifest (deletes nothing)
prune:
    {{node}} npm run -s publish-photos -- --source "{{portfolio}}" --prune --dry-run

# Delete unreferenced R2 objects — asks for confirmation first
[confirm("Delete unreferenced objects from R2? This cannot be undone. [y/N]")]
prune-yes:
    {{node}} npm run -s publish-photos -- --source "{{portfolio}}" --prune --yes

# Undo a local-preview manifest and remove local images (do this before committing)
reset-local:
    git checkout -- apps/photo/src/data/manifest.json
    rm -rf apps/photo/public/_local-img

# Publish to R2, then commit + push the manifest so Cloudflare deploys
release message="photos: update": publish
    git add apps/photo/src/data/manifest.json
    git diff --cached --quiet && echo "manifest unchanged — nothing to release" || { git commit -m "{{message}}" && git push; }

# ---------- housekeeping ----------

# Remove build output and caches (keeps node_modules and the derivative cache)
clean:
    rm -rf apps/*/dist apps/*/.astro

# Remove node_modules and the photo derivative cache too
[confirm("Remove node_modules and ~/.cache/nachogoca-photos? [y/N]")]
clean-all: clean
    rm -rf node_modules apps/*/node_modules tools/*/node_modules "$HOME/.cache/nachogoca-photos"
