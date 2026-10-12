import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const STORE_PATH = fileURLToPath(new URL('../data/tickets.json', import.meta.url));
const hasJira = () => ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'].every(key => process.env[key]);

async function readStore() {
  try { return JSON.parse(await readFile(STORE_PATH, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function writeStore(tickets) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(tickets, null, 2)}\n`, 'utf8');
}

async function jiraRequest(path, options = {}) {
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  const response = await fetch(`${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3${path}`, {
    ...options,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers }
  });
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.status === 204 ? {} : response.json();
}

function jiraDescription(ticket) {
  const text = `Employee email: ${ticket.email}\nCategory: ${ticket.category}\nPriority: ${ticket.priority}\n\n${ticket.description}`;
  return { type: 'doc', version: 1, content: text.split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) };
}

export async function createTicket(ticket) {
  if (hasJira()) {
    const created = await jiraRequest('/issue', {
      method: 'POST', body: JSON.stringify({ fields: {
        project: { key: process.env.JIRA_PROJECT_KEY }, issuetype: { name: 'Task' },
        summary: ticket.summary, description: jiraDescription(ticket),
        labels: [`smartdesk-${ticket.category.toLowerCase()}`, `priority-${ticket.priority.toLowerCase()}`]
      } })
    });
    return { id: created.key, url: `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/browse/${created.key}`, status: 'Open', provider: 'Jira' };
  }
  const tickets = await readStore();
  const created = { id: `SD-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`, ...ticket, status: 'Open', updates: [], createdAt: new Date().toISOString() };
  tickets.push(created);
  await writeStore(tickets);
  return { id: created.id, url: null, status: created.status, provider: 'local demo store' };
}

export async function findTickets(email) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('A valid employee email is required.');
  if (hasJira()) {
    const safeEmail = normalized.replaceAll('"', '\\"');
    const jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND text ~ "${safeEmail}" ORDER BY created DESC`;
    const result = await jiraRequest(`/search?jql=${encodeURIComponent(jql)}&fields=summary,status,description,comment&maxResults=50`);
    return (result.issues ?? []).filter(issue => JSON.stringify(issue.fields.description ?? '').toLowerCase().includes(normalized)).map(issue => ({
      id: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name ?? 'Unknown',
      updates: (issue.fields.comment?.comments ?? []).map(comment => comment.body?.content?.flatMap(block => block.content ?? []).map(part => part.text ?? '').join('') ?? '').slice(-3),
      url: `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/browse/${issue.key}`, provider: 'Jira'
    }));
  }
  return (await readStore()).filter(ticket => ticket.email.toLowerCase() === normalized).map(({ id, summary, status, updates, url, provider }) => ({ id, summary, status, updates, url, provider: provider ?? 'local demo store' }));
}

export function ticketingMode() { return hasJira() ? 'Jira Cloud' : 'local demo ticket store'; }
