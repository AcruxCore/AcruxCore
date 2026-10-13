import type { ImageContentPart } from '../providers/types';
import { isImagePart } from '../providers/message-content';
import { ValidationError } from '../../shared/errors';
import { ImageUrlSchema } from './completions.types';
import { isOmittedImage } from '../../traces/spans/redact';

/**
 * Collects the image parts of messages, in order, without checking them.
 *
 * @param messages - Any messages; a string or `null` `content` has no image.
 * @returns The image parts; empty when there are none.
 */
export function imagePartsOf(messages: ReadonlyArray<{ content: unknown }>): ImageContentPart[] {
  return messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as Array<{ type: string }>).filter((p) => isImagePart(p as ImageContentPart)) : [],
  ) as ImageContentPart[];
}

/**
 * Collects the image parts of messages that came out of a stored prompt, and checks each URL.
 *
 * A request's own image URLs are checked by the request schema. A stored prompt's image URL is
 * a template, so it can only be checked after it is filled in. Without this check, a variable
 * that is missing or mistyped sends an empty or broken URL to the provider, which fails with
 * its own message instead of one that names the problem.
 *
 * @param messages - Messages rendered from a stored prompt; a string `content` has no image.
 * @returns The image parts, in order; empty when there are none.
 * @throws {ValidationError} If an image URL is not an http(s) URL or a `data:image/...;base64,` URL.
 *   A trace's `[image omitted: …]` placeholder gets its own message, because the fix differs.
 */
export function checkedImages(messages: ReadonlyArray<{ content: unknown }>): ImageContentPart[] {
  const images = imagePartsOf(messages);
  for (const image of images) {
    const url = image.image_url.url;
    if (ImageUrlSchema.safeParse(url).success) continue;
    if (isOmittedImage(url)) {
      throw new ValidationError(
        `This example has no image to send. The value "${url}" was copied from a trace, and a trace does not keep an image that was sent as inline data. Edit the example and put a public image link in that variable.`,
      );
    }
    throw new ValidationError(
      `Image URL "${url.slice(0, 60)}" is not an http(s) URL or a data:image/...;base64 URL. Check the variable that fills it.`,
    );
  }
  return images;
}
