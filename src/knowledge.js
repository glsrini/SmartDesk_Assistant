import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const KB_PATH = fileURLToPath(new URL('../data/knowledge_base.json', import.meta.url));
const STOP = new Set('a an and are as at be by can do for from how i in is it of on or the to what when where which with your my'.split(' '));
const tokenize = value => String(value).toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 1 && !STOP.has(word)) ?? [];

export async function loadKnowledgeBase() {
  const entries = JSON.parse(await readFile(KB_PATH, 'utf8'));
  if (!Array.isArray(entries) || entries.length < 30) throw new Error('Knowledge base must contain at least 30 entries.');
  return entries;
}

export async function searchKnowledgeBase(query) {
  const entries = await loadKnowledgeBase();
  const terms = tokenize(query);
  if (!terms.length) return { found: false, reason: 'No searchable terms were supplied.', results: [] };
  const scored = entries.map(entry => {
    const titleTokens = new Set(tokenize(entry.title));
    const bodyTokens = tokenize(`${entry.category} ${entry.title} ${entry.content}`);
    const counts = new Map();
    for (const token of bodyTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const matchWeight = terms.reduce((sum, term) => sum + (titleTokens.has(term) ? 2.5 : Math.min(counts.get(term) ?? 0, 2)), 0);
    const coverage = terms.filter(term => counts.has(term)).length / terms.length;
    const score = Math.min(1, (matchWeight / (terms.length * 2.5)) * 0.7 + coverage * 0.3);
    return { ...entry, score: Number(score.toFixed(3)) };
  }).filter(row => row.score >= 0.12).sort((a, b) => b.score - a.score).slice(0, 5);
  const threshold = 0.4;
  const relevant = scored.filter(row => row.score >= threshold);
  return { found: relevant.length > 0, threshold, results: relevant };
}
