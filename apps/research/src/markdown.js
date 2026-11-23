import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import {matchArtifactReference} from './artifact-references.js';

const md = new MarkdownIt({html: false, linkify: false, typographer: false});
md.use(texmath, {
  engine: katex,
  delimiters: ['brackets', 'dollars'],
  katexOptions: {output: 'mathml', trust: false, strict: 'ignore', maxSize: 16, maxExpand: 500},
});

// A site marker in G(H*) is part of the adsorbate name, even within **bold**.
md.inline.ruler.before('emphasis', 'adsorption_site', (state, silent) => {
  const pos = state.pos;
  if (!state.src.startsWith('*)', pos) ||
      !/[GEH]\((?:[A-Z][a-z]?\d*)+$/.test(state.src.slice(Math.max(0, pos - 40), pos))) return false;
  if (!silent) state.pending += '*';
  state.pos++;
  return true;
});

md.renderer.rules.table_open = () => '<div class="md-table" tabindex="0" role="region" aria-label="数据表"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
// An answer or document can describe an image without making an external request.
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content);

function referenceAttributes(file) {
  return [['type', 'button'], ['class', 'message-artifact-reference'], ['data-artifact-id', file.id],
    ['aria-label', '预览结果：' + file.name]];
}

md.core.ruler.after('inline', 'research_references', state => {
  const {artifacts, currentArtifacts} = state.env;
  for (const block of state.tokens) {
    if (!block.children) continue;
    let linkTag;
    for (const token of block.children) {
      if (token.type === 'link_open') {
        const href = token.attrGet('href');
        const file = matchArtifactReference(href, artifacts, currentArtifacts);
        if (file) {
          token.tag = 'button';
          token.attrs = referenceAttributes(file);
        } else if (/^https?:\/\//i.test(href)) {
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noopener noreferrer');
        } else {
          token.tag = 'span';
          token.attrs = [];
        }
        linkTag = token.tag;
      } else if (token.type === 'link_close') {
        token.tag = linkTag;
        linkTag = undefined;
      } else if (token.type === 'code_inline' && !linkTag) {
        token.meta = matchArtifactReference(token.content, artifacts, currentArtifacts);
      }
    }
  }
});

const inlineCode = md.renderer.rules.code_inline;
md.renderer.rules.code_inline = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const content = inlineCode(tokens, index, options, env, renderer);
  if (!token.meta) return content;
  const attributes = renderer.renderAttrs({attrs: referenceAttributes(token.meta)});
  return '<button' + attributes + '>' + content + '</button>';
};

export function renderMarkdown(text, artifacts = [], currentArtifacts = artifacts) {
  return md.render(String(text ?? ''), {artifacts, currentArtifacts});
}
