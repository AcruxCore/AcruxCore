/**
 * Adds `github` to the admonition keywords, keeping the built-in ones.
 *
 * `:::github` is the standard block every guide, tutorial and post uses to link its code
 * in the repo (scripts, notebooks, data files). Docusaurus only parses keywords it is told
 * about, so both configs pass this to every content plugin that renders pages; the block
 * itself is drawn by `src/theme/Admonition/Type/GitHub.tsx`.
 */
export const GITHUB_ADMONITION = {keywords: ['github'], extendDefaults: true};
