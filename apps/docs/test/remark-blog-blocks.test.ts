// Runs plugins/remark-blog-blocks.ts on real markdown and checks the HTML elements it
// will produce, through the same mdast → hast step Docusaurus uses.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {toHast} from 'mdast-util-to-hast';
import remarkBlogBlocks, {type Node} from '../plugins/remark-blog-blocks.ts';

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: {className?: string[]};
  children?: HastNode[];
}

function render(markdown: string): HastNode {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(markdown) as unknown as Node;
  remarkBlogBlocks()(tree);
  return toHast(tree as never) as HastNode;
}

function all(node: HastNode, found: HastNode[] = []): HastNode[] {
  found.push(node);
  for (const child of node.children ?? []) all(child, found);
  return found;
}

function withClass(root: HastNode, className: string): HastNode[] {
  return all(root).filter((n) => n.properties?.className?.includes(className));
}

function text(node: HastNode): string {
  return node.value ?? (node.children ?? []).map(text).join('');
}

describe('remark-blog-blocks', () => {
  it('badges Yes, No and Beta cells and leaves their text alone', () => {
    const tree = render('| Tool | Gateway |\n|---|---|\n| A | Yes: hosted |\n| B | No |\n| C | Beta |\n| D | 4 |\n| E | No — in none of 3 runs |\n');
    assert.deepEqual(withClass(tree, 'acx-cell--yes').map(text), ['Yes: hosted']);
    assert.deepEqual(withClass(tree, 'acx-cell--no').map(text), ['No', 'No — in none of 3 runs']);
    assert.deepEqual(withClass(tree, 'acx-cell--partial').map(text), ['Beta']);
    assert.equal(withClass(tree, 'acx-cell').length, 4);
  });

  it('does not badge a sentence that only starts with the word No or Yes', () => {
    const tree = render('| A | B |\n|---|---|\n| x | No public price; ask sales |\n| y | Yes we can |\n| z | Not checked |\n');
    assert.equal(withClass(tree, 'acx-cell').length, 0);
  });

  it('badges a cell whose Yes is a link', () => {
    const tree = render('| A | B |\n|---|---|\n| x | [Yes](https://example.com): traces |\n');
    assert.equal(withClass(tree, 'acx-cell--yes').length, 1);
  });

  it('puts "Where X differs" and "Limits of X" side by side', () => {
    const tree = render('**Where MLflow differs**\n\n- one\n- two\n\n**Limits of MLflow**\n\n- three\n');
    const [block] = withClass(tree, 'acx-procon');
    assert.ok(block, 'no acx-procon wrapper');
    assert.equal(block.tagName, 'div');
    assert.match(text(withClass(block, 'acx-procon__col--pro')[0]), /Where MLflow differs.*one.*two/s);
    assert.match(text(withClass(block, 'acx-procon__col--con')[0]), /Limits of MLflow.*three/s);
  });

  it('leaves a lone "Where X differs" list unwrapped', () => {
    const tree = render('**Where MLflow differs**\n\n- one\n\nA paragraph.\n');
    assert.equal(withClass(tree, 'acx-procon').length, 0);
  });

  it('wraps the short answer, and tags Best for, Sources and table labels', () => {
    const tree = render(
      [
        '**The short answer**',
        '- **Cheapest:** Opik.',
        '**Best for:** small teams.',
        'Sources: [license](https://example.com).',
        'Our comparison: [A vs B](/blog/a-vs-b).',
        '**Features**',
        '| A | B |\n|---|---|\n| 1 | 2 |',
      ].join('\n\n'),
    );
    assert.match(text(withClass(tree, 'acx-summary')[0]), /The short answer.*Cheapest/s);
    assert.equal(withClass(tree, 'acx-bestfor').length, 1);
    assert.equal(withClass(tree, 'acx-sources').length, 1);
    assert.equal(withClass(tree, 'acx-related').length, 1);
    assert.deepEqual(withClass(tree, 'acx-table-label').map(text), ['Features']);
  });

  it('turns a quote that opens with "Key point:" into a crux, and leaves a plain quote alone', () => {
    const tree = render('> **Key point:** Langfuse has no gateway.\n\n> Spend alerts are informational-only.\n');
    const cruxes = withClass(tree, 'acx-crux');
    assert.equal(cruxes.length, 1);
    assert.equal(cruxes[0].tagName, 'blockquote');
    assert.match(text(cruxes[0]), /Key point: Langfuse has no gateway/);
  });

  it('does not treat a bold sentence in prose as a table label', () => {
    const tree = render('**Features**\n\nSome prose.\n');
    assert.equal(withClass(tree, 'acx-table-label').length, 0);
  });
});
