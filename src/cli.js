import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createReusableAgent, getReusableAgentId } from './agent-definition.js';
import { loadKnowledgeBase, searchKnowledgeBase } from './knowledge.js';
import { runSmartDesk } from './session.js';

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.has('--check-kb')) {
    const entries = await loadKnowledgeBase();
    const result = await searchKnowledgeBase('how do I reset my password');
    console.log(`Knowledge base: ${entries.length} entries`);
    console.log('Retrieval demonstration:', JSON.stringify(result.results.map(({ id, title, score }) => ({ id, title, score })), null, 2));
    return;
  }
  if (flags.has('--create-agent')) {
    const agent = await createReusableAgent();
    console.log(`Created reusable agent: ${agent.id}`);
    return;
  }
  if (flags.has('--agent-id')) {
    console.log(await getReusableAgentId());
    return;
  }
  await runSmartDesk({
    forceCreateAgent: flags.has('--recreate-agent'),
    initialMessage: process.env.SMARTDESK_INITIAL_MESSAGE || 'Hello! I am SmartDesk AI. How can I help with an IT or HR question today?'
  });
}

main().catch(error => {
  console.error(`SmartDesk could not continue: ${error.message}`);
  process.exitCode = 1;
});
