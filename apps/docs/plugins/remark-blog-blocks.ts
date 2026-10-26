/**
 * Gives the blog's recurring writing patterns a visual shape, without touching the posts.
 *
 * The posts are CommonMark `.md`, so they cannot use JSX components. They do repeat the
 * same few patterns, though: comparison tables full of "Yes" and "No", a "**Best for:**"
 * line under each tool, "**Where X differs**" and "**Limits of X**" lists, a
 * "**The short answer**" list and "Sources:" lines. This plugin finds those patterns in
 * the mdast and adds class names (through `data.hProperties`) or wraps them in a `div`
 * (through `data.hName`). `src/css/custom.css` styles the classes under `.acx-*`.
 *
 * The text itself never changes: a "Yes" cell still reads "Yes" to a screen reader and
 * to a crawler; the badge is CSS only. A post that does not use a pattern is unaffected.
 *
 * Registered only in `docusaurus.blog.config.ts`.
 */

/** The slice of an mdast node this plugin reads and writes. */
export interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: {hName?: string; hProperties?: Record<string, unknown>};
}

/**
 * The word must be the whole answer or be followed by punctuation or a dash ("Yes: traces",
 * "Beta (preview)", "No — in none of 3 runs"). "No public price" is a sentence, not a No,
 * and a cross beside it would misreport the row.
 */
const ANSWER_END = String.raw`(?=$|[:,;.)]|\s[(—–])`;

/** Table-cell values that get a badge, matched at the start of the cell's text. */
const CELL_KINDS: Array<[RegExp, string]> = [
  [new RegExp(`^Yes${ANSWER_END}`), 'yes'],
  [new RegExp(`^No${ANSWER_END}`), 'no'],
  [new RegExp(`^(Partial|Partly|Beta)${ANSWER_END}`), 'partial'],
];

/** The plain text of a node and all its descendants. */
function textOf(node: Node): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

/** Adds class names (space-separated) to a node's future HTML element. */
function addClass(node: Node, className: string): void {
  node.data ??= {};
  node.data.hProperties ??= {};
  const existing = node.data.hProperties.className;
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  node.data.hProperties.className = [...list, ...className.split(' ')];
}

/** A `div` node holding the given children, with the given (space-separated) class names. */
function wrap(className: string, children: Node[]): Node {
  return {type: 'acxBlock', children, data: {hName: 'div', hProperties: {className: className.split(' ')}}};
}

/** True when a paragraph holds nothing but one bold run whose text matches `pattern`. */
function isBoldLabel(node: Node | undefined, pattern: RegExp): boolean {
  if (node?.type !== 'paragraph' || node.children?.length !== 1) return false;
  const only = node.children[0];
  return only.type === 'strong' && pattern.test(textOf(only).trim());
}

/** True when a paragraph opens with a bold run whose text matches `pattern`. */
function startsWithBold(node: Node, pattern: RegExp): boolean {
  const first = node.children?.[0];
  return node.type === 'paragraph' && first?.type === 'strong' && pattern.test(textOf(first).trim());
}

/** Tags every table cell whose text starts with Yes, No, Partial or Beta. */
function tagCells(node: Node): void {
  if (node.type === 'tableCell') {
    const text = textOf(node).trim();
    const kind = CELL_KINDS.find(([pattern]) => pattern.test(text))?.[1];
    if (kind) addClass(node, `acx-cell acx-cell--${kind}`);
    return;
  }
  for (const child of node.children ?? []) tagCells(child);
}

/**
 * Rewrites one list of sibling nodes: tags single paragraphs and folds label + list pairs
 * into wrappers. Returns the new list; the input array is not mutated.
 */
function transformSiblings(children: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const next = children[i + 1];

    // "**Where X differs**" + list, then "**Limits of X**" + list → two cards side by side.
    if (
      isBoldLabel(node, /^Where .+ differs?$/) &&
      next?.type === 'list' &&
      isBoldLabel(children[i + 2], /^Limits of /) &&
      children[i + 3]?.type === 'list'
    ) {
      out.push(
        wrap('acx-procon', [
          wrap('acx-procon__col acx-procon__col--pro', [node, next]),
          wrap('acx-procon__col acx-procon__col--con', [children[i + 2], children[i + 3]]),
        ]),
      );
      i += 3;
      continue;
    }

    // "**The short answer**" + list → a summary card.
    if (isBoldLabel(node, /^(The short answer|In short|TL;DR)$/i) && next?.type === 'list') {
      out.push(wrap('acx-summary', [node, next]));
      i += 1;
      continue;
    }

    // "> **Key point:** …" → the post's crux. A plain quote stays a quote: posts use `>` for
    // text copied from a vendor's UI or docs, which must not read as our own takeaway.
    const firstInQuote = node.type === 'blockquote' ? node.children?.[0] : undefined;
    if (firstInQuote && startsWithBold(firstInQuote, /^(Key point|The crux|Bottom line):?$/i)) {
      addClass(node, 'acx-crux');
    } else if (startsWithBold(node, /^Best for:?$/)) addClass(node, 'acx-bestfor');
    else if (node.type === 'paragraph' && /^Sources?:/.test(textOf(node))) addClass(node, 'acx-sources');
    else if (node.type === 'paragraph' && /^Our (hands-on )?comparison/.test(textOf(node))) {
      addClass(node, 'acx-related');
    } else if (isBoldLabel(node, /^[A-Z][^.]{0,60}$/) && next?.type === 'table') {
      // A short bold line straight above a table is that table's caption.
      addClass(node, 'acx-table-label');
    }
    out.push(node);
  }
  return out;
}

/** Applies {@link transformSiblings} to every parent in the tree. */
function transformTree(node: Node): void {
  if (!node.children) return;
  for (const child of node.children) transformTree(child);
  node.children = transformSiblings(node.children);
}

/**
 * The remark plugin. Docusaurus runs `remarkPlugins` after its own defaults, so the
 * admonitions are already resolved when this sees the tree.
 *
 * @returns A transformer that edits the mdast tree in place.
 */
export default function remarkBlogBlocks(): (tree: Node) => void {
  return (tree) => {
    tagCells(tree);
    transformTree(tree);
  };
}
