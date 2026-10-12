import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { curlJson, streamEvents } from './agents-api.js';
import { getReusableAgentId } from './agent-definition.js';
import { searchKnowledgeBase } from './knowledge.js';
import { createTicket, findTickets, ticketingMode } from './tickets.js';

const TERMINAL_EVENTS = new Set(['agent.session.turn.completed', 'agent.session.turn.failed', 'agent.session.turn.cancelled', 'agent.session.failed', 'agent.session.environment.failed', 'error']);
const proposals = new Map();
const approvedProposalKeys = new Set();

export function authorizeTicketConfirmation(message) {
  const affirmative = /^(yes(?:[\s,]+please)?|yeah|yep|please do|go ahead|confirm|confirmed|create it|submit it|proceed)[.!\s]*$/i.test(message.trim());
  if (!affirmative || proposals.size === 0) return false;
  for (const proposal of proposals.values()) approvedProposalKeys.add(proposal.key);
  return approvedProposalKeys.size > 0;
}

function showEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'agent.session.turn.output_text.delta') {
    stdout.write(event.delta ?? '');
    return;
  }
  if (event.type === 'agent.session.turn.output_text.done' || event.type === 'agent.session.turn.completed') stdout.write('\n');
  if (event.type === 'agent.session.requires_action') console.log('\n[SmartDesk is requesting an application tool]');
  if (event.type === 'error' || event.type === 'agent.session.error' || event.type === 'agent.session.turn.failed' || event.type === 'agent.session.failed') {
    console.error('\n[Agents API event]', JSON.stringify(event.error ?? event));
  } else if (event.type !== 'agent.session.turn.output_text.delta') {
    console.log(`[event] ${event.type ?? 'unknown'}`);
  }
}

function requiredActions(event) {
  return event?.session?.required_actions ?? event?.required_actions ?? [];
}

export async function executeFunction(action) {
  const args = typeof action.arguments === 'string' ? JSON.parse(action.arguments) : (action.arguments ?? {});
  if (action.name === 'search_knowledge_base') return await searchKnowledgeBase(args.query);
  if (action.name === 'create_support_ticket') {
    const email = String(args.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please collect a valid employee email address before creating a ticket.');
    const ticket = {
      email, summary: String(args.summary ?? '').trim(), description: String(args.description ?? '').trim(),
      category: args.category, priority: args.priority
    };
    if (!ticket.summary || !ticket.description) throw new Error('A summary and detailed description are required.');
    const key = [ticket.email, ticket.summary, ticket.description, ticket.category, ticket.priority].join('|').toLowerCase();
    if (!args.confirmed) {
      proposals.set(action.call_id, { key, ticket });
      return { created: false, confirmation_required: true, ticket, message: 'Proposal stored. Show it to the employee and wait for their explicit confirmation.' };
    }
    const approved = [...proposals.entries()].find(([, proposal]) => proposal.key === key);
    if (!approved || !approvedProposalKeys.has(key)) throw new Error('This exact ticket proposal has not received explicit employee confirmation. Present the proposal and wait for a clear yes before creating it.');
    proposals.delete(approved[0]);
    approvedProposalKeys.delete(key);
    return { created: true, ...(await createTicket(ticket)) };
  }
  if (action.name === 'get_ticket_status') {
    const email = String(args.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please collect a valid employee email address to look up tickets.');
    let tickets = await findTickets(email);
    if (args.ticket_id) tickets = tickets.filter(ticket => ticket.id.toLowerCase() === String(args.ticket_id).trim().toLowerCase());
    return { count: tickets.length, tickets };
  }
  throw new Error(`Unknown application tool: ${action.name}`);
}

async function submitToolResults(sessionId, actions) {
  if (!actions.length) return;
  const events = [];
  for (const action of actions) {
    let result;
    try { result = { success: true, output: JSON.stringify(await executeFunction(action)) }; }
    catch (error) { result = { success: false, error: error.message }; }
    events.push({ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, ...result });
    console.log(`[tool] ${action.name}: ${result.success ? 'completed' : 'reported an error'}`);
  }
  await curlJson(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, 'POST', { events });
}

async function consumeStream(initialSessionId = null, firstResponsePath = null, firstStream = null) {
  let sessionId = initialSessionId;
  let path = firstResponsePath;
  let terminal = false;
  let idleCycles = 0;
  let fatalStreamError = null;
  const handled = new Set();
  while (!terminal) {
    let sawEvent = false;
    try {
      const events = firstStream ?? streamEvents(path ?? `/agents/sessions/${encodeURIComponent(sessionId)}/events`);
      firstStream = null;
      for await (const event of events) {
        sawEvent = true;
        path = null;
        sessionId ??= event.session_id ?? event.session?.id ?? event.session?.session_id;
        showEvent(event);
        const actions = requiredActions(event).filter(action => !handled.has(action.call_id));
        if (actions.length) {
          actions.forEach(action => handled.add(action.call_id));
          await submitToolResults(sessionId, actions);
        }
        if (event.type === 'error' || event.type === 'agent.session.failed' || event.type === 'agent.session.environment.failed' || event.type === 'agent.session.turn.failed' || event.type === 'agent.session.turn.cancelled') {
          fatalStreamError = event.error?.message ?? event.turn?.error?.message ?? `The agent session ended with ${event.type}.`;
          terminal = true;
          throw new Error(fatalStreamError);
        }
        if (TERMINAL_EVENTS.has(event.type)) terminal = true;
      }
    } catch (error) {
      console.error(`\nStream error: ${error.message}`);
      if (!sawEvent || fatalStreamError) throw error;
    }
    if (!terminal) {
      idleCycles++;
      if (idleCycles > 6) {
        console.error('The event stream closed before the turn completed. Reconnect or inspect the saved session history before retrying side effects.');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  return sessionId;
}

export async function runSmartDesk({ forceCreateAgent = false, initialMessage = 'Hello, I need help with an IT or HR question.' } = {}) {
  const agentId = await getReusableAgentId({ forceCreate: forceCreateAgent });
  console.log(`Using reusable agent: ${agentId}`);
  console.log(`Ticket provider: ${ticketingMode()}`);
  const firstStream = streamEvents('/agents/sessions', 'POST', {
    agent_id: agentId,
    environment: { type: 'none' },
    input: initialMessage,
    stream: true
  });
  const sessionId = await consumeStream(null, null, firstStream);
  if (!sessionId) throw new Error('The Agents API stream completed without returning a session ID.');
  console.log(`\nSession: ${sessionId}`);
  const terminal = await curlJson(`/agents/sessions/${encodeURIComponent(sessionId)}`, 'GET');
  const state = terminal.status ?? terminal.state;
  if (['failed', 'cancelled'].includes(state)) throw new Error(`The first session turn ended in ${state}.`);

  console.log('\nSmartDesk is ready. Enter /exit to end this CLI (the API session remains saved).');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const message = (await rl.question('\nYou: ')).trim();
      if (!message) continue;
      if (message === '/exit' || message === '/quit') break;
      authorizeTicketConfirmation(message);
      const eventsPath = `/agents/sessions/${encodeURIComponent(sessionId)}/events`;
      const streaming = consumeStream(sessionId, eventsPath);
      await new Promise(resolve => setTimeout(resolve, 350));
      const { randomUUID } = await import('node:crypto');
      await curlJson(eventsPath, 'POST', { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }] }] }, [`Idempotency-Key: ${randomUUID()}`]);
      await streaming;
    }
  } finally { rl.close(); }
  console.log(`\nSession saved: ${sessionId}`);
}
