# nachogoca.com

Static sites built with Astro. Cloudflare Pages deploys them on every push to `main`, and each PR gets a preview URL.

| App | Domain | Source |
|-----|--------|--------|
| home | nachogoca.com | `apps/home` |
| photo gallery | photo.nachogoca.com | `apps/photo` |
| images (R2 bucket `nachogoca-photos`) | img.nachogoca.com | written by `tools/publish-photos` |

The shared look (colours, header, footer, theme toggle) lives in `packages/ui`.

## Publishing photos

1. Export edits as usual into `~/Photography/Edits/YYYY/MM_event/`.
2. Copy the keepers into `~/Photography/Portfolio/YYYY/MM_event/`, using the same folder name.
   You can add an optional `series.yaml` to that folder:
   ```yaml
   title: Tromsø            # default: from folder name
   slug: tromso-2026        # default: <event>-<year>
   date: 2026-03-14         # default: earliest EXIF capture date
   description: Arctic Norway in March.
   cover: _DSC7730.jpg      # default: first image
   order: [_DSC7730.jpg, _DSC7726.jpg]   # default: capture time
   images:
     _DSC7726.jpg: { caption: "Ersfjordbotn", alt: "Snowy mountain reflected in a fjord" }
   hidden: false
   ```
3. Optionally, preview locally:
   `npm run publish-photos -- --target local && npm run dev:photo`
4. Publish with `npm run publish-photos`. It uploads new derivatives to R2 and rewrites
   `apps/photo/src/data/manifest.json`. Commit and push that file, and Cloudflare deploys it.

What gets published:
- 800/1600/2400 px versions in AVIF and JPEG, converted to sRGB.
- **All metadata is stripped: no GPS, no EXIF.**
- Filenames are content hashes, and the originals never leave your machine.
- Derivatives are cached in `~/.cache/nachogoca-photos/`, so a re-run only processes new photos.
  The first run of a large photo takes about 10 s per image, mostly AVIF encoding.

To remove photos:
1. Delete them from Portfolio, re-run publish, and push.
2. Run `npm run publish-photos -- --prune` to list R2 objects nothing references any more.
3. Add `--yes` to delete them.

R2 credentials live in `~/.config/nachogoca-site/r2.env`. Keep it at chmod 600 and never put it in the repo.

## Development

```sh
npm install
npm run dev:home     # http://localhost:4321
npm run dev:photo
npm run build
```

The home page has one optional env var, `PUBLIC_CONTACT_EMAIL`, which adds an email icon. Set it in
Cloudflare Pages → Settings → Variables, or locally in `apps/home/.env` (gitignored).

## Security

- There's no server, no database, and no admin panel.
- Each app's `public/_headers` sets strict CSP and HSTS headers, and there are no inline scripts.
- The Cloudflare build refuses a manifest that points at local images.
- CI holds no secrets, because deploys go through Cloudflare's GitHub integration.
