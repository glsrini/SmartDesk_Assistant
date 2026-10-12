import { spawn } from 'node:child_process';
import { once } from 'node:events';

const API_ROOT = 'https://api.openai.com/v1';
const PROJECT_ID = process.env.OPENAI_PROJECT_ID || 'proj_2mzAhWk9r2mmsb1MA1Wfq1h1';

export class AgentsApiError extends Error {
  constructor(message, status = undefined) {
    super(message);
    this.name = 'AgentsApiError';
    this.status = status;
  }
}

function baseArgs(path, method) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AgentsApiError('OPENAI_API_KEY is not set. Copy .env.example to .env and add an API key with Agents read/write and Responses write permissions.');
  return [
    '--silent', '--show-error', '--fail-with-body', '--request', method,
    `${API_ROOT}${path}`,
    '--header', `Authorization: Bearer ${key}`,
    '--header', `OpenAI-Project: ${PROJECT_ID}`,
    '--header', 'OpenAI-Beta: agents=v1',
    '--header', 'Content-Type: application/json'
  ];
}

export function curlJson(path, method, body, extraHeaders = []) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const args = [...baseArgs(path, method)];
    for (const header of extraHeaders) args.push('--header', header);
    if (body !== undefined) args.push('--data-binary', '@-');
    args.push('--write-out', '\n__SMARTDESK_HTTP_STATUS__:%{http_code}');
    const child = spawn(process.env.CURL_PATH || 'curl', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new AgentsApiError(`Could not start curl: ${error.message}`)));
    child.on('close', code => {
      const statusMatch = stdout.match(/\n__SMARTDESK_HTTP_STATUS__:(\d{3})\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : undefined;
      const responseBody = statusMatch ? stdout.slice(0, statusMatch.index).trim() : stdout.trim();
      if (code !== 0 || (status !== undefined && status >= 400)) {
        let detail = responseBody;
        try {
          const parsed = JSON.parse(responseBody);
          detail = parsed.error?.message ?? responseBody;
          if (parsed.error?.param) detail += ` (parameter: ${parsed.error.param})`;
          if (parsed.error?.code) detail += ` (code: ${parsed.error.code})`;
        } catch { /* Use the raw, bounded response body when it is not JSON. */ }
        const prefix = status ? `OpenAI API returned HTTP ${status}` : (stderr.trim() || `curl exited with status ${code}`);
        return reject(new AgentsApiError(`${prefix}: ${(detail || stderr.trim() || 'No error details returned.').slice(0, 1000)}`, status));
      }
      try { resolve(responseBody ? JSON.parse(responseBody) : {}); }
      catch { reject(new AgentsApiError(`The Agents API returned non-JSON content: ${stdout.slice(0, 400)}`)); }
    });
    if (body === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(body));
  });
}

export async function* streamEvents(path, method = 'GET', body = undefined) {
  const args = [...baseArgs(path, method), '--no-buffer', '--include'];
  if (body !== undefined) args.push('--data-binary', '@-');
  const child = spawn(process.env.CURL_PATH || 'curl', args, { windowsHide: true, stdio: [body === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (body !== undefined) child.stdin.end(JSON.stringify(body));
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let buffer = '';
  let dataLines = [];
  let sawData = false;
  const emitBlock = () => {
    if (!dataLines.length) return null;
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw === '[DONE]') return { type: 'stream.done' };
    try { return JSON.parse(raw); }
    catch { return { type: 'stream.parse_error', raw }; }
  };
  try {
    for await (const chunk of child.stdout) {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('HTTP/')) continue;
        if (line.startsWith('data:')) { sawData = true; dataLines.push(line.slice(5).trimStart()); }
        else if (line === '' && dataLines.length) {
          const event = emitBlock();
          if (event) yield event;
        }
      }
    }
    if (dataLines.length) { const event = emitBlock(); if (event) yield event; }
    const [code] = await once(child, 'close');
    if (code !== 0) throw new AgentsApiError(stderr.trim() || `Event stream curl exited with status ${code}`);
    if (!sawData && stderr.trim()) throw new AgentsApiError(stderr.trim());
  } catch (error) {
    child.kill();
    throw error;
  }
}

export { API_ROOT };
