/// <reference types="astro/client" />
interface ImportMetaEnv {
  /** Optional. Shown as a mailto: icon on the home page when set (Cloudflare Pages env var / local .env). */
  readonly PUBLIC_CONTACT_EMAIL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
