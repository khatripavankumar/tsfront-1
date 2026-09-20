import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'assessment');
const dataDir = resolve(root, 'data');
const dbPath = resolve(dataDir, 'assessai.sqlite');
const envPath = resolve(root, '.env');

// Load local development settings without adding a dependency. Production hosts
// should provide these values through their own environment configuration.
if (existsSync(envPath)) {
  const envFile = await readFile(envPath, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const port = Number(process.env.PORT || 3000);
const sessionDays = 14;

await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'candidate')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some(column => column.name === 'name')) db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''");

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createUserFromEnvironment(email, password, role) {
  if (!email || !password || password.startsWith('replace-with-')) return;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (email, name, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)').run(email, email.split('@')[0], hash, salt, role);
  console.log(`Created ${role} account for ${email}`);
}

createUserFromEnvironment(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, 'admin');
createUserFromEnvironment(process.env.CANDIDATE_EMAIL, process.env.CANDIDATE_PASSWORD, 'candidate');

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const publicFiles = new Set(['/','/index.html','/login.html','/signup.html','/signin.html']);
const protectedRoles = {
  '/02_candidate.html': 'candidate',
  '/ai_interview.html': 'candidate',
  '/candidate_progress.html': 'candidate',
  '/progress_dashboard.html': 'admin',
  '/admin_dashboard.html': 'admin',
  '/01_generator.html': ['admin', 'candidate'],
  '/03_evaluator.html': 'admin',
  '/04_report.html': 'admin'
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
    const index = cookie.indexOf('=');
    return [cookie.slice(0, index).trim(), decodeURIComponent(cookie.slice(index + 1).trim())];
  }));
}

function sessionCookie(token, maxAge = sessionDays * 86400) {
  return `assessai_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function tokenId(token) { return createHash('sha256').update(token).digest('hex'); }

function currentUser(request) {
  const token = parseCookies(request).assessai_session;
  if (!token) return null;
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(tokenId(token));
  if (!session || session.expires_at < Date.now()) return null;
  return db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(session.user_id);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || '{}');
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function requireCandidate(request, response) {
  const user = currentUser(request);
  if (!user || user.role !== 'candidate') {
    sendJson(response, 401, { error: 'Candidate authentication required.' });
    return null;
  }
  return user;
}

const voiceInterviewInstructions = `You are AssessAI, a professional voice interviewer for a Senior Frontend Engineer. Conduct a natural spoken interview. Do not display or dictate a fixed list of questions. Ask one adaptive question at a time, listen without interrupting, and ask concise follow-ups based on the candidate's answer. Cover technical reasoning, collaboration/behavior, and communication. After enough evidence (normally 6 to 9 exchanges), say clearly that the interview is complete and thank the candidate. Keep each turn short and conversational.`;

async function serveFile(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) return sendJson(response, 400, { error: 'Invalid path' });
  if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Not found' });
  const content = await readFile(filePath);
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  response.end(content);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (request.method === 'POST' && pathname === '/api/login') {
      const body = await readBody(request);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const requestedRole = body.role === 'admin' ? 'admin' : 'candidate';
      const user = db.prepare('SELECT id, email, role, password_hash, password_salt FROM users WHERE email = ?').get(email);
      if (!user || user.role !== requestedRole || !passwordMatches(password, user.password_salt, user.password_hash)) {
        return sendJson(response, 401, { error: 'Invalid email, password, or account role.' });
      }
      const rawToken = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(tokenId(rawToken), user.id, Date.now() + sessionDays * 86400000);
      return sendJson(response, 200, { user: { email: user.email, role: user.role } }, { 'Set-Cookie': sessionCookie(rawToken) });
    }

    if (request.method === 'POST' && pathname === '/api/signup') {
      const body = await readBody(request);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!name || !email || password.length < 10) {
        return sendJson(response, 400, { error: 'Enter your name, a valid email, and a password of at least 10 characters.' });
      }
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) return sendJson(response, 409, { error: 'An account with this email already exists. Please sign in.' });
      const { salt, hash } = hashPassword(password);
      db.prepare('INSERT INTO users (email, name, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)').run(email, name, hash, salt, 'candidate');
      return sendJson(response, 201, { message: 'Account created. You can now sign in.' });
    }

    if (request.method === 'POST' && pathname === '/api/logout') {
      const token = parseCookies(request).assessai_session;
      if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (request.method === 'GET' && pathname === '/api/me') {
      const user = currentUser(request);
      return user ? sendJson(response, 200, { user }) : sendJson(response, 401, { error: 'Authentication required' });
    }

    if (request.method === 'POST' && pathname === '/api/realtime/offer') {
      if (!requireCandidate(request, response)) return;
      if (!process.env.OPENAI_API_KEY) return sendJson(response, 503, { error: 'Voice interview is not configured. Add OPENAI_API_KEY to the server environment.' });
      const { sdp } = await readBody(request);
      if (typeof sdp !== 'string' || !sdp.startsWith('v=')) return sendJson(response, 400, { error: 'A valid WebRTC offer is required.' });
      const form = new FormData();
      form.set('sdp', new Blob([sdp], { type: 'application/sdp' }), 'offer.sdp');
      form.set('session', JSON.stringify({ type: 'realtime', model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime', instructions: voiceInterviewInstructions, audio: { output: { voice: 'marin' } } }));
      const aiResponse = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
      const answer = await aiResponse.text();
      if (!aiResponse.ok) return sendJson(response, aiResponse.status, { error: 'Unable to start the AI voice interview.', detail: answer.slice(0, 500) });
      response.writeHead(200, { 'Content-Type': 'application/sdp' });
      return response.end(answer);
    }

    if (request.method === 'POST' && pathname === '/api/interview/evaluate') {
      if (!requireCandidate(request, response)) return;
      if (!process.env.OPENAI_API_KEY) return sendJson(response, 503, { error: 'AI evaluation is not configured.' });
      const { transcript } = await readBody(request);
      if (!Array.isArray(transcript) || !transcript.length) return sendJson(response, 400, { error: 'Interview transcript is required.' });
      const conversation = transcript.slice(-40).map(item => `${item.role === 'candidate' ? 'Candidate' : 'Interviewer'}: ${String(item.text || '').slice(0, 1600)}`).join('\n');
      const prompt = `Evaluate this voice interview for a Senior Frontend Engineer. Score technical_judgment, collaboration_behavior, and communication from 0 to 100. Return ONLY valid JSON: {"technical_judgment":number,"collaboration_behavior":number,"communication":number,"summary":string,"strengths":[string],"growth_focus":[string]}. Be evidence-based and do not infer protected characteristics.\n\n${conversation}`;
      const aiResponse = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_EVALUATION_MODEL || 'gpt-5-mini', input: prompt, text: { format: { type: 'json_object' } } }) });
      const payload = await aiResponse.json();
      if (!aiResponse.ok) return sendJson(response, aiResponse.status, { error: 'Unable to evaluate the interview.' });
      let evaluation;
      try { evaluation = JSON.parse(payload.output_text); } catch { return sendJson(response, 502, { error: 'AI returned an invalid evaluation.' }); }
      return sendJson(response, 200, { evaluation });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed' });

    const requiredRole = protectedRoles[pathname];
    if (requiredRole) {
      const user = currentUser(request);
      if (!user) return redirect(response, `/signin.html?next=${encodeURIComponent(pathname)}`);
      const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
      if (!allowedRoles.includes(user.role)) return sendJson(response, 403, { error: 'This account is not authorized for this area.' });
    }

    if (publicFiles.has(pathname) || requiredRole) return serveFile(request, response, pathname);
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Unexpected server error' });
  }
});

server.listen(port, () => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  console.log(`AssessAI running at http://localhost:${port}`);
  console.log(count ? `${count} database user(s) available.` : 'No users yet. Set ADMIN_* and/or CANDIDATE_* environment variables before starting.');
});
