#!/usr/bin/env node
// publish-photos — turn ~/Photography/Portfolio/YYYY/MM_event/*.jpg into the photo site.
//
//   1. resize to web widths (AVIF + JPEG), auto-orient, convert to sRGB
//   2. strip ALL metadata (EXIF/GPS/XMP/IPTC) — only an sRGB ICC profile is embedded
//   3. upload to R2 under content-hashed keys (idempotent; existing keys are skipped)
//   4. write apps/photo/src/data/manifest.json (no filenames, no GPS — just ids, sizes, captions)
//
// Usage:
//   npm run publish-photos -- [--target r2|local] [--source DIR] [--only YYYY/MM_event]
//                             [--dry-run] [--prune [--yes]]
//
//   --target local   writes derivatives to apps/photo/public/_local-img for `npm run dev:photo`
//                    (that manifest is refused by the Cloudflare build — re-run with r2 before pushing)
//   --prune          list R2 objects no longer referenced by the manifest; add --yes to delete them
//
// R2 credentials: ~/.config/nachogoca-site/r2.env (chmod 600)
//   R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…  R2_BUCKET=nachogoca-photos
//   IMAGE_BASE=https://img.nachogoca.com

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import exifReader from "exif-reader";
import YAML from "yaml";

const PIPELINE_VERSION = 1; // bump to force regeneration of every derivative
const WIDTHS = [800, 1600, 2400];
const JPEG = { quality: 82, mozjpeg: true, progressive: true };
const AVIF = { quality: 55, effort: 4 };
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);
const MIME = { jpg: "image/jpeg", avif: "image/avif" };
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const manifestPath = path.join(repoRoot, "apps/photo/src/data/manifest.json");
const localImgDir = path.join(repoRoot, "apps/photo/public/_local-img");
const cacheDir = path.join(os.homedir(), ".cache/nachogoca-photos", `v${PIPELINE_VERSION}`);

const { values: args } = parseArgs({
  options: {
    target: { type: "string", default: "r2" },
    source: { type: "string", default: path.join(os.homedir(), "Photography/Portfolio") },
    only: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    prune: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (!["r2", "local"].includes(args.target)) die(`--target must be r2 or local`);

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ---------- discovery ----------

/** Portfolio/YYYY/MM_event/ → series candidates */
async function discoverSeries(root) {
  if (!existsSync(root)) die(`source folder not found: ${root}`);
  const out = [];
  for (const year of (await readdir(root)).sort()) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(root, year);
    if (!statSync(yearDir).isDirectory()) continue;
    for (const event of (await readdir(yearDir)).sort()) {
      const dir = path.join(yearDir, event);
      if (!statSync(dir).isDirectory() || event.startsWith(".") || event.startsWith("_")) continue;
      const rel = `${year}/${event}`;
      if (args.only && rel !== args.only) continue;
      const files = (await readdir(dir))
        .filter((f) => !f.startsWith(".") && IMAGE_EXT.has(path.extname(f).toLowerCase()))
        .sort();
      if (files.length) out.push({ year: Number(year), event, rel, dir, files });
    }
  }
  return out;
}

function readSeriesYaml(dir) {
  const p = path.join(dir, "series.yaml");
  if (!existsSync(p)) return {};
  const doc = YAML.parse(readFileSync(p, "utf8")) ?? {};
  if (typeof doc !== "object") die(`${p}: expected a mapping`);
  return doc;
}

function defaultsFromFolder(year, event) {
  const m = event.match(/^(\d{2})(?:-(\d{2}))?_(.+)$/);
  const name = m ? m[3] : event;
  const title = name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${year}`;
  const date = m ? `${year}-${m[1]}-${m[2] ?? "01"}` : `${year}-01-01`;
  return { title, slug, date };
}

// ---------- image processing ----------

function hex(n) {
  return n.toString(16).padStart(2, "0");
}

function captureDate(exifBuf) {
  if (!exifBuf) return undefined;
  try {
    const e = exifReader(exifBuf);
    const d = e?.Photo?.DateTimeOriginal ?? e?.Image?.DateTime;
    return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : undefined;
  } catch {
    return undefined;
  }
}

async function processImage(file, keyPrefix) {
  const buf = await readFile(file);
  const id = createHash("sha256")
    .update(buf)
    .update(JSON.stringify({ PIPELINE_VERSION, WIDTHS, JPEG, AVIF }))
    .digest("hex")
    .slice(0, 12);
  const key = `${keyPrefix}/${id}`;

  const meta = await sharp(buf).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const origW = rotated ? meta.height : meta.width;
  const origH = rotated ? meta.width : meta.height;
  let widths = WIDTHS.filter((w) => w <= origW);
  if (widths.length === 0) widths = [origW];
  const maxW = widths.at(-1);
  const outH = Math.round((origH * maxW) / origW);

  const files = [];
  for (const w of widths) {
    for (const fmt of ["avif", "jpg"]) {
      const name = `${key}-${w}.${fmt}`;
      const cached = path.join(cacheDir, name);
      if (!existsSync(cached)) {
        await mkdir(path.dirname(cached), { recursive: true });
        // No .withMetadata()/.keepExif(): sharp drops EXIF, GPS, XMP and IPTC by default.
        // .withIccProfile('srgb') converts to sRGB and embeds only that colour profile.
        let pipe = sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).withIccProfile("srgb");
        pipe = fmt === "avif" ? pipe.avif(AVIF) : pipe.jpeg(JPEG);
        await pipe.toFile(cached);
      }
      files.push({ name, cached, fmt });
    }
  }

  const { dominant } = await sharp(buf).rotate().resize(64).stats();
  const color = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;

  return {
    photo: { id, key, w: maxW, h: outH, widths, formats: ["avif", "jpg"], color },
    date: captureDate(meta.exif),
    files,
  };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ---------- R2 ----------

function loadR2Env() {
  const p = path.join(os.homedir(), ".config/nachogoca-site/r2.env");
  if (!existsSync(p)) die(`missing ${p} (see header of this script)`);
  const mode = statSync(p).mode & 0o077;
  if (mode) die(`${p} is readable by others — run: chmod 600 ${p}`);
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "IMAGE_BASE"]) {
    if (!env[k]) die(`${p}: ${k} is not set`);
  }
  return env;
}

async function r2Client(env) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

async function listKeys(s3, bucket) {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const keys = new Set();
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) keys.add(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ---------- main ----------

async function main() {
  const found = await discoverSeries(args.source);
  if (!found.length) console.log(`No series found under ${args.source} (expected YYYY/MM_event/*.jpg).`);

  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { series: [] };
  const allFiles = [];
  const series = [];

  for (const s of found) {
    const cfg = readSeriesYaml(s.dir);
    if (cfg.hidden) {
      console.log(`- ${s.rel}: hidden, skipped`);
      continue;
    }
    const def = defaultsFromFolder(s.year, s.event);
    const meta = cfg.images ?? {};
    const order = cfg.order ?? [];
    for (const f of [...order, ...Object.keys(meta), cfg.cover].filter(Boolean)) {
      if (!s.files.includes(f)) die(`${s.rel}/series.yaml references missing file: ${f}`);
    }

    process.stdout.write(`- ${s.rel}: ${s.files.length} images … `);
    const processed = await pool(s.files, Math.max(1, Math.floor(os.cpus().length / 2)), (f) =>
      processImage(path.join(s.dir, f), `${s.year}/${s.event}`),
    );
    console.log("ok");

    const rows = s.files.map((f, i) => ({ file: f, ...processed[i] }));
    const rank = (f) => (order.includes(f) ? order.indexOf(f) : Infinity);
    rows.sort((a, b) => rank(a.file) - rank(b.file) || (a.date ?? "").localeCompare(b.date ?? "") || a.file.localeCompare(b.file));

    const title = cfg.title ?? def.title;
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    const date = cfg.date ? String(cfg.date).slice(0, 10) : (dates[0] ?? def.date);
    const images = rows.map((r) => {
      const m = meta[r.file] ?? {};
      allFiles.push(...r.files);
      return {
        ...r.photo,
        alt: m.alt ?? `${title}, ${s.year}`,
        ...(m.caption ? { caption: m.caption } : {}),
        ...(r.date ? { date: r.date } : {}),
      };
    });
    const coverRow = cfg.cover ? rows.find((r) => r.file === cfg.cover) : rows[0];

    series.push({
      slug: cfg.slug ?? def.slug,
      title,
      date,
      year: Number(date.slice(0, 4)),
      ...(cfg.description ? { description: String(cfg.description).trim() } : {}),
      cover: coverRow.photo.id,
      images,
    });
  }

  const slugs = series.map((s) => s.slug);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dup) die(`duplicate slug "${dup}" — set slug: in one of the series.yaml files`);

  // --only publishes one series but keeps the rest of the existing manifest
  const merged = args.only
    ? [...previous.series.filter((p) => !series.some((s) => s.slug === p.slug) && !p.images[0]?.key.startsWith(`${args.only}/`)), ...series]
    : series;

  let imageBase;
  if (args.target === "local") {
    imageBase = "/_local-img";
    if (!args["dry-run"]) {
      for (const f of allFiles) {
        const dest = path.join(localImgDir, f.name);
        if (!existsSync(dest)) {
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(f.cached, dest);
        }
      }
    }
  } else {
    const env = loadR2Env();
    imageBase = env.IMAGE_BASE.replace(/\/$/, "");
    const s3 = await r2Client(env);
    const existing = await listKeys(s3, env.R2_BUCKET);
    const todo = allFiles.filter((f) => !existing.has(f.name));
    const bytes = (await Promise.all(todo.map((f) => stat(f.cached)))).reduce((a, s) => a + s.size, 0);
    console.log(`R2: ${allFiles.length - todo.length} objects already present, ${todo.length} to upload (${(bytes / 1e6).toFixed(1)} MB)`);

    if (!args["dry-run"] && todo.length) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      let done = 0;
      await pool(todo, 8, async (f) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: env.R2_BUCKET,
            Key: f.name,
            Body: await readFile(f.cached),
            ContentType: MIME[f.fmt],
            CacheControl: CACHE_CONTROL,
          }),
        );
        process.stdout.write(`\r  uploaded ${++done}/${todo.length}`);
      });
      process.stdout.write("\n");
    }

    if (args.prune) {
      if (args.only) die("--prune cannot be combined with --only");
      const referenced = new Set(allFiles.map((f) => f.name));
      const orphans = [...existing].filter((k) => !referenced.has(k)).sort();
      console.log(`R2: ${orphans.length} unreferenced objects`);
      orphans.slice(0, 50).forEach((k) => console.log(`  ${k}`));
      if (orphans.length > 50) console.log(`  … and ${orphans.length - 50} more`);
      if (orphans.length && args.yes && !args["dry-run"]) {
        const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
        for (let i = 0; i < orphans.length; i += 1000) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: env.R2_BUCKET,
              Delete: { Objects: orphans.slice(i, i + 1000).map((Key) => ({ Key })) },
            }),
          );
        }
        console.log(`R2: deleted ${orphans.length} objects`);
      } else if (orphans.length) {
        console.log("  (re-run with --prune --yes to delete them)");
      }
    }
  }

  const manifest = { version: 1, imageBase, generatedAt: new Date().toISOString(), series: merged };
  if (args["dry-run"]) {
    console.log(`dry run: would write ${merged.length} series to ${path.relative(repoRoot, manifestPath)}`);
    return;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✓ wrote ${path.relative(repoRoot, manifestPath)} — ${merged.length} series, ${merged.reduce((a, s) => a + s.images.length, 0)} photos`);
  if (args.target === "local") {
    console.log("  local preview only: run `npm run dev:photo`. Re-run with --target r2 before committing.");
  } else {
    console.log("  next: git add apps/photo/src/data/manifest.json && git commit -m 'photos: …' && git push");
  }
}

main().catch((e) => die(e.stack ?? String(e)));
