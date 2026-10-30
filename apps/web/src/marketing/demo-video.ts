/**
 * The landing page's one-minute intro video, described once.
 *
 * `LandingPage.tsx` renders the player from these values and
 * `structured-data.ts` describes the same file as a VideoObject, so the
 * player and the JSON-LD cannot point at different files or disagree on
 * the length.
 */
export interface DemoVideo {
  /**
   * Absolute URL of the MP4, served from object storage (Cloudflare R2).
   *
   * Deliberately **not** bundled: the file is a regenerated artifact, so
   * committing it would add a multi-megabyte blob to git history on every
   * re-record. It is also not a YouTube embed — that costs ~1.5 MB of
   * third-party JavaScript plus cookies, more page weight than the video
   * itself, and its end screen links visitors away from the page.
   *
   * Empty string = the section is not rendered at all and no
   * VideoObject is emitted, so the page can never ship a player or a schema
   * pointing at a URL that 404s. Set this once the object is live.
   *
   * Served from the `acruxcore-media` bucket via the `media.acruxcore.com`
   * custom domain — a **subdomain** on purpose. Connecting the bare apex to a
   * bucket replaces the root hostname route and takes the whole site offline;
   * that is not hypothetical, it happened on 2026-07-28.
   *
   * Cloudflare returns this with `max-age=14400`, so re-uploading under the
   * same key leaves stale copies at the edge for up to four hours. Either purge
   * the cache or upload under a new dated key and update this line.
   */
  url: string;
  /**
   * Same-origin poster path, also the VideoObject thumbnail. Poster and
   * captions are same-origin because both are small and needed before playback.
   */
  poster: string;
  /** Same-origin WebVTT captions path. */
  captions: string;
  /** Length in whole seconds, emitted as the VideoObject's ISO 8601 duration. */
  durationSeconds: number;
  /** `YYYY-MM-DD` the current cut went live. Update it when the file is replaced. */
  uploadDate: string;
  /** The video's title, as the section heading names it. */
  name: string;
  /** What the video shows, as the section's intro paragraph says it. */
  description: string;
}

/** The intro video currently on the landing page. */
export const DEMO_VIDEO: DemoVideo = {
  url: 'https://media.acruxcore.com/acruxcore-intro-720p.mp4',
  poster: '/media/intro-poster.jpg',
  captions: '/media/acruxcore-intro.vtt',
  durationSeconds: 65,
  uploadDate: '2026-10-06',
  name: 'The whole platform in about a minute.',
  description:
    'Versioned prompts shipped by moving an alias, tools with their own versions and error rates, one gateway in front of every provider, a trace for every call, evals that turn failures into scored fixes, and an audit trail on every plan.',
};
