import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { loadKnowledgeBase, searchKnowledgeBase } from '../src/knowledge.js';
import { createTicket, findTickets, ticketingMode } from '../src/tickets.js';
import { authorizeTicketConfirmation, executeFunction } from '../src/session.js';
import { agentDefinition } from '../src/agent-definition.js';
import { curlJson } from '../src/agents-api.js';

const original = Object.fromEntries(['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'OPENAI_API_KEY', 'OPENAI_PROJECT_ID'].map(key => [key, process.env[key]]));
const restoreEnv = () => { for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; };
const setDemoMode = () => { for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']) delete process.env[key]; };
const setJiraMode = () => Object.assign(process.env, { JIRA_BASE_URL: 'https://jira.example.test', JIRA_EMAIL: 'agent@example.test', JIRA_API_TOKEN: 'test-token', JIRA_PROJECT_KEY: 'SD' });

after(async () => {
  restoreEnv();
  await rm(new URL('../data/tickets.json', import.meta.url), { force: true });
});

test('knowledge base contains at least 30 entries across required domains', async () => {
  const entries = await loadKnowledgeBase();
  assert.ok(entries.length >= 30);
  for (const domain of ['IT', 'HR', 'Payroll', 'Onboarding']) assert.ok(entries.some(entry => entry.category === domain));
});

test('retrieval ranks the password reset chunk for a password reset question', async () => {
  const result = await searchKnowledgeBase('How can I reset a forgotten password?');
  assert.equal(result.found, true);
  assert.equal(result.results[0].id, 'IT-01');
  assert.ok(result.results[0].score >= result.threshold);
});

test('retrieval ranks expense reimbursement content for an expense question', async () => {
  const result = await searchKnowledgeBase('How can I submit a business expense reimbursement?');
  assert.equal(result.results[0].id, 'HR-04');
});

test('retrieval returns no chunks for an unrelated question', async () => {
  const result = await searchKnowledgeBase('How do I engineer quantum entanglement?');
  assert.equal(result.found, false);
  assert.deepEqual(result.results, []);
});

test('retrieval handles empty or stopword-only queries safely', async () => {
  assert.equal((await searchKnowledgeBase('')).found, false);
  assert.equal((await searchKnowledgeBase('how do I')).found, false);
});

test('local ticket creation returns a trackable ID and status', async () => {
  setDemoMode();
  const ticket = await createTicket({ email: 'person@example.com', summary: 'Monitor flickers', description: 'Flickers since Monday', category: 'IT', priority: 'Medium' });
  assert.match(ticket.id, /^SD-/);
  assert.equal(ticket.status, 'Open');
  assert.equal(ticket.provider, 'local demo store');
});

test('local ticket status lookup filters by email and returns none for an unknown employee', async () => {
  setDemoMode();
  assert.equal((await findTickets('person@example.com')).length, 1);
  assert.deepEqual(await findTickets('nobody@example.com'), []);
});

test('ticket status lookup rejects invalid email input', async () => {
  setDemoMode();
  await assert.rejects(findTickets('not-an-email'), /valid employee email/i);
});

test('ticket status flow handles multiple tickets and exact ticket selection', async () => {
  setDemoMode();
  const email = 'multi@example.com';
  await createTicket({ email, summary: 'VPN issue', description: 'VPN does not connect.', category: 'IT', priority: 'Medium' });
  const second = await createTicket({ email, summary: 'Leave portal question', description: 'Portal reports an error.', category: 'HR', priority: 'Low' });
  const all = await executeFunction({ name: 'get_ticket_status', arguments: { email, ticket_id: null } });
  assert.equal(all.count, 2);
  const chosen = await executeFunction({ name: 'get_ticket_status', arguments: { email, ticket_id: second.id } });
  assert.equal(chosen.count, 1);
  assert.equal(chosen.tickets[0].id, second.id);
});

test('ticket status flow clearly represents an employee with no matching tickets', async () => {
  setDemoMode();
  const result = await executeFunction({ name: 'get_ticket_status', arguments: { email: 'none@example.com', ticket_id: null } });
  assert.deepEqual(result, { count: 0, tickets: [] });
});

test('ticket proposal rejects missing summary or description', async () => {
  setDemoMode();
  await assert.rejects(executeFunction({ name: 'create_support_ticket', call_id: 'missing-details-1', arguments: {
    email: 'required@example.com', summary: '', description: 'details', category: 'IT', priority: 'Low', confirmed: false
  } }), /summary and detailed description/i);
});

test('unknown function call returns an explicit handler error', async () => {
  await assert.rejects(executeFunction({ name: 'delete_everything', arguments: {} }), /Unknown application tool/);
});

test('ticket creation first stages a proposal without creating a side effect', async () => {
  setDemoMode();
  const before = await findTickets('proposal@example.com');
  const result = await executeFunction({ name: 'create_support_ticket', call_id: 'proposal-stage-1', arguments: {
    email: 'proposal@example.com', summary: 'VPN disconnects', description: 'VPN disconnects every 10 minutes.', category: 'IT', priority: 'High', confirmed: false
  } });
  assert.equal(result.created, false);
  assert.equal(result.confirmation_required, true);
  assert.deepEqual(await findTickets('proposal@example.com'), before);
});

test('ticket creation blocks confirmation until an explicit affirmative user message', async () => {
  setDemoMode();
  const args = { name: 'create_support_ticket', call_id: 'proposal-confirm-2', arguments: {
    email: 'approval@example.com', summary: 'Email setup issue', description: 'Unable to enroll phone in mail app.', category: 'IT', priority: 'Medium', confirmed: false
  } };
  await executeFunction(args);
  const confirmation = { ...args, call_id: 'proposal-confirm-3', arguments: { ...args.arguments, confirmed: true } };
  await assert.rejects(executeFunction(confirmation), /explicit employee confirmation/i);
  assert.equal(authorizeTicketConfirmation('maybe later'), false);
  assert.equal(authorizeTicketConfirmation('Yes, please!'), true);
  const created = await executeFunction(confirmation);
  assert.equal(created.created, true);
  assert.equal((await findTickets('approval@example.com')).length, 1);
});

test('a changed ticket proposal cannot reuse the previous employee confirmation', async () => {
  setDemoMode();
  await executeFunction({ name: 'create_support_ticket', call_id: 'proposal-changed-1', arguments: {
    email: 'changed@example.com', summary: 'Laptop issue', description: 'Laptop will not boot.', category: 'IT', priority: 'Low', confirmed: false
  } });
  authorizeTicketConfirmation('go ahead');
  await assert.rejects(executeFunction({ name: 'create_support_ticket', call_id: 'proposal-changed-2', arguments: {
    email: 'changed@example.com', summary: 'Laptop replacement', description: 'Laptop will not boot.', category: 'IT', priority: 'Low', confirmed: true
  } }), /exact ticket proposal/i);
});

test('ticket function rejects malformed employee email before any ticket write', async () => {
  setDemoMode();
  await assert.rejects(executeFunction({ name: 'create_support_ticket', call_id: 'invalid-email-1', arguments: {
    email: 'bad', summary: 'Issue', description: 'Description', category: 'IT', priority: 'Low', confirmed: false
  } }), /valid employee email/i);
});

test('Jira ticket creation calls the REST issue endpoint and includes employee context', async () => {
  setJiraMode();
  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ key: 'SD-123' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await createTicket({ email: 'jane@example.com', summary: 'VPN issue', description: 'Disconnects while at home.', category: 'IT', priority: 'High' });
    assert.equal(result.id, 'SD-123');
    assert.equal(result.url, 'https://jira.example.test/browse/SD-123');
    assert.equal(request.url, 'https://jira.example.test/rest/api/3/issue');
    assert.equal(request.body.fields.project.key, 'SD');
    assert.match(request.body.fields.description.content[0].content[0].text, /jane@example.com/);
  } finally { globalThis.fetch = previousFetch; restoreEnv(); }
});

test('Jira status search returns tickets tied to email and ignores text-only false positives', async () => {
  setJiraMode();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ issues: [
    { key: 'SD-1', fields: { summary: 'VPN', status: { name: 'In Progress' }, description: { content: [{ content: [{ text: 'Employee email: jane@example.com' }] }] }, comment: { comments: [] } } },
    { key: 'SD-2', fields: { summary: 'Payroll', status: { name: 'Open' }, description: { content: [{ content: [{ text: 'Employee email: other@example.com' }] }] }, comment: { comments: [] } } }
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const tickets = await findTickets('jane@example.com');
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 'SD-1');
    assert.equal(tickets[0].status, 'In Progress');
  } finally { globalThis.fetch = previousFetch; restoreEnv(); }
});

test('Jira status lookup handles an empty result set', async () => {
  setJiraMode();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ issues: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { assert.deepEqual(await findTickets('empty@example.com'), []); }
  finally { globalThis.fetch = previousFetch; restoreEnv(); }
});

test('Jira service failures surface a useful error instead of pretending success', async () => {
  setJiraMode();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('permission denied', { status: 403 });
  try { await assert.rejects(createTicket({ email: 'a@example.com', summary: 'issue', description: 'details', category: 'HR', priority: 'Medium' }), /Jira returned HTTP 403/); }
  finally { globalThis.fetch = previousFetch; restoreEnv(); }
});

test('agent definition uses requested model settings and both hosted and application tools', () => {
  assert.equal(agentDefinition.name, 'New agent');
  assert.equal(agentDefinition.model, 'gpt-6-astra');
  assert.deepEqual(agentDefinition.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(agentDefinition.multi_agent.enabled, false);
  assert.ok(agentDefinition.tools.some(tool => tool.type === 'web_search' && Object.keys(tool).length === 1));
  assert.ok(agentDefinition.tools.filter(tool => tool.type === 'function').every(tool => !('strict' in tool)));
  assert.deepEqual(agentDefinition.tools.filter(tool => tool.type === 'function').map(tool => tool.name), ['search_knowledge_base', 'create_support_ticket', 'get_ticket_status']);
});

test('Agents API reports missing credentials without printing or attempting the key', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(curlJson('/agents', 'POST', {}), /OPENAI_API_KEY is not set/i);
});

test('ticket provider selects Jira only when its complete environment is configured', () => {
  setDemoMode();
  assert.equal(ticketingMode(), 'local demo ticket store');
  setJiraMode();
  assert.equal(ticketingMode(), 'Jira Cloud');
});

test('knowledge base remains portable JSON without environment-specific absolute paths', async () => {
  const text = await readFile(new URL('../data/knowledge_base.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /[A-Z]:\\\\Users\\\\/i);
  assert.doesNotThrow(() => JSON.parse(text));
});
