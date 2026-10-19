/** The entities `escape-html` writes, decoded back. `&amp;` is last so `&amp;quot;` stays literal text. */
const ENTITIES: Array<[RegExp, string]> = [
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'],
];

/** The slice of an mdast/MDX node this plugin reads. */
interface Node {
  type: string;
  name?: string | null;
  attributes?: Array<{type: string; name?: string; value?: unknown}>;
  children?: Node[];
}

/** Reverses `escape-html` on one string. */
function unescapeHtml(value: string): string {
  return ENTITIES.reduce((text, [pattern, char]) => text.replace(pattern, char), value);
}

/** Visits every node of the tree, depth first. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Undoes the double escaping of a local image's alt text (issue #463).
 *
 * Docusaurus 3.10's built-in `transformImage` turns `![alt](./img.png)` into an `<img>` JSX
 * element and stores the alt as `escapeHtml(alt)`. A JSX attribute value is a literal
 * string, and React escapes it again when it renders, so `"` reached the page as the text
 * `&quot;` and `'` as `&#39;`. A screen reader read those characters out in the middle of
 * the sentence. Nothing visible changed, which is why it went unnoticed.
 *
 * Registered in `remarkPlugins`, which Docusaurus runs after its own default plugins, so
 * this always sees the element `transformImage` produced. Images with a remote URL are
 * never touched by `transformImage` and keep their plain `alt`.
 *
 * @returns The remark transformer.
 */
export default function remarkUnescapeImageAlt(): (tree: Node) => void {
  return (tree) => {
    walk(tree, (node) => {
      const isJsxImg =
        (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') && node.name === 'img';
      if (!isJsxImg) return;
      for (const attr of node.attributes ?? []) {
        if (attr.type === 'mdxJsxAttribute' && attr.name === 'alt' && typeof attr.value === 'string') {
          attr.value = unescapeHtml(attr.value);
        }
      }
    });
  };
}
