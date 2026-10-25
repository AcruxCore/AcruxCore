/**
 * `@id` of the company in schema.org structured data.
 *
 * The marketing site declares the Organization under this id in
 * apps/web/index.html, and both Docusaurus sites repeat it (site-shared.ts), so
 * the docs, the blog and acruxcore.com describe one company rather than three.
 * Kept in its own file because the blog's client-side theme code imports it,
 * and site-shared.ts pulls in Node-only modules.
 */
export const ORGANIZATION_ID = 'https://acruxcore.com/#org';
