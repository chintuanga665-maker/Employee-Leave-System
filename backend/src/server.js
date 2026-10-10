import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, databaseKind, findRequest, initializeDatabase, publicProfileRequest, publicRequest, publicUser, withTransaction } from './db.js';
import { sendEmailNotification, sendNotifications } from './notifications.js';
import { attachRealtime } from './realtime.js';

const app = express();
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const scrypt = promisify(scryptCallback);
const COOKIE = 'elms_session';
const lifetime = 7 * 24 * 60 * 60 * 1000;
const attempts = new Map();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
  .split(',').map(value => value.trim()).filter(Boolean);
let broadcast = () => {};

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  } else if (origin) {
    return res.status(403).json({ error: 'This website is not allowed to connect to the API.' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const hash = value => createHash('sha256').update(value).digest('hex');
function readCookie(req) {
  const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : '';
}
function setCookie(res, token) {
  const crossSite = process.env.NODE_ENV === 'production';
  res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=${crossSite ? 'None' : 'Lax'}; Path=/; Max-Age=${lifetime / 1000}${crossSite ? '; Secure' : ''}`);
}
function clearCookie(res) {
  const crossSite = process.env.NODE_ENV === 'production';
  res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=${crossSite ? 'None' : 'Lax'}; Path=/; Max-Age=0${crossSite ? '; Secure' : ''}`);
}

async function auth(req, res, next) {
  try {
    const token = readCookie(req);
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
    const tokenHash = hash(token);
    const row = await db.get(`SELECT s.expires_at,u.*,o.name AS organization_name
      FROM sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN organizations o ON o.id=u.organization_id WHERE s.token_hash=?`, tokenHash);
    if (!row || row.expires_at <= new Date().toISOString()) {
      if (row) await db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
      clearCookie(res);
      return res.status(401).json({ error: 'Your sign-in expired. Please sign in again.' });
    }
    req.user = publicUser(row);
    req.tokenHash = tokenHash;
    next();
  } catch (error) { next(error); }
}
const role = wanted => (req, res, next) => req.user?.role === wanted ? next() : res.status(403).json({ error: `Only ${wanted}s can do that.` });

async function createSession(userId, res) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + lifetime).toISOString();
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(token), userId, expires);
  await db.run('DELETE FROM sessions WHERE expires_at<=?', new Date().toISOString());
  setCookie(res, token);
}
function validEmail(value) { return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function cleanPhone(value) { return typeof value === 'string' ? value.replace(/[\s()-]/g, '') : ''; }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function weekdays(start, end) {
  let total = 0;
  for (let day = new Date(`${start}T12:00:00Z`), last = new Date(`${end}T12:00:00Z`); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) total++;
  }
  return total;
}
async function saveNotifications(requestId, recipientId, items) {
  for (const item of items) await db.run(`INSERT INTO notifications(id,request_id,recipient_user_id,channel,recipient,message,delivery_status,status_note,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, item.id, requestId, recipientId, item.channel, item.recipient, item.message,
  item.deliveryStatus, item.statusNote, item.createdAt);
}
function rateLimited(req) {
  const address = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = attempts.get(address);
  if (item?.blocked > now) return true;
  if (!item || item.started < now - 900000) attempts.set(address, { started: now, count: 0, blocked: 0 });
  return false;
}
function failed(req) {
  const address = req.socket.remoteAddress || 'unknown';
  const item = attempts.get(address) || { started: Date.now(), count: 0, blocked: 0 };
  if (++item.count >= 8) item.blocked = Date.now() + 900000;
  attempts.set(address, item);
}

app.get('/api/health', async (_req, res, next) => {
  try { await db.get('SELECT 1 AS ready'); res.json({ status: 'ok', database: databaseKind }); }
  catch (error) { next(error); }
});

app.get('/api/organizations/:inviteCode/managers', async (req, res, next) => {
  try {
    const organization = await db.get('SELECT id FROM organizations WHERE employee_invite_code=?', String(req.params.inviteCode || ''));
    if (!organization) return res.status(404).json({ error: 'Workspace invite code not found.' });
    res.json(await db.all("SELECT id,name,team FROM users WHERE organization_id=? AND role='manager' ORDER BY LOWER(name)", organization.id));
  } catch (error) { next(error); }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = cleanPhone(req.body?.phone);
    const password = String(req.body?.password || '');
    const userRole = String(req.body?.role || '');
    const team = String(req.body?.team || '').trim().slice(0, 80) || 'General';
    const managerId = String(req.body?.managerId || '');
    const organizationName = String(req.body?.organizationName || '').trim();
    const employeeInviteCode = String(req.body?.employeeInviteCode || '').trim();
    const managerInviteCode = String(req.body?.managerInviteCode || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter a name between 2 and 80 characters.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter a WhatsApp number with country code, such as +14155550123.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Use a password between 10 and 128 characters.' });
    if (!['employee', 'manager'].includes(userRole)) return res.status(400).json({ error: 'Choose employee or manager.' });

    let assigned = null;
    let organization = null;
    const createOrganization = userRole === 'manager' && !managerInviteCode;
    if (userRole === 'manager') {
      if (createOrganization) {
        if (organizationName.length < 2 || organizationName.length > 100) return res.status(400).json({ error: 'Enter a workspace name between 2 and 100 characters, or use a manager invite code to join one.' });
        organization = { id: randomUUID() };
      } else {
        organization = await db.get('SELECT id FROM organizations WHERE manager_invite_code=?', managerInviteCode);
        if (!organization) return res.status(403).json({ error: 'That manager invite code is not valid.' });
      }
    } else {
      organization = await db.get('SELECT id FROM organizations WHERE employee_invite_code=?', employeeInviteCode);
      if (!organization) return res.status(403).json({ error: 'Enter a valid workspace invite code from your manager.' });
      assigned = await db.get("SELECT id FROM users WHERE id=? AND role='manager' AND organization_id=?", managerId, organization.id);
      if (!assigned) return res.status(400).json({ error: 'Choose a manager from your workspace.' });
    }

    const id = randomUUID();
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    const now = new Date().toISOString();
    try {
      await withTransaction(async tx => {
        if (createOrganization) await tx.run('INSERT INTO organizations(id,name,employee_invite_code,manager_invite_code,created_at) VALUES(?,?,?,?,?)',
          organization.id, organizationName, randomBytes(18).toString('base64url'), randomBytes(24).toString('base64url'), now);
        await tx.run('INSERT INTO users(id,name,email,phone,team,role,manager_id,organization_id,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          id, name, email, phone, team, userRole, assigned?.id || null, organization.id, salt, passwordHash, now);
      });
    } catch (error) {
      if (error.code === '23505' || String(error.code).includes('CONSTRAINT')) return res.status(409).json({ error: 'An account with that email already exists.' });
      throw error;
    }
    const created = await db.get('SELECT u.*,o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE u.id=?', id);
    await createSession(id, res);
    if (assigned) broadcast([assigned.id], { type: 'refresh', reason: 'team-member-created' });
    res.status(201).json({ user: publicUser(created) });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (rateLimited(req)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await db.get('SELECT u.*,o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE LOWER(u.email)=LOWER(?)', email);
    let valid = false;
    if (user && password.length <= 128) valid = timingSafeEqual(await scrypt(password, user.salt, 64), Buffer.from(user.password_hash, 'hex'));
    if (!valid) { failed(req); return res.status(401).json({ error: 'Email or password is incorrect.' }); }
    attempts.delete(req.socket.remoteAddress || 'unknown');
    await createSession(user.id, res);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', auth, async (req, res, next) => {
  try { await db.run('DELETE FROM sessions WHERE token_hash=?', req.tokenHash); clearCookie(res); res.status(204).end(); }
  catch (error) { next(error); }
});

app.get('/api/team', auth, role('manager'), async (req, res, next) => {
  try {
    const people = await db.all(`SELECT u.*,o.name AS organization_name,COUNT(r.id) AS request_count,
      SUM(CASE WHEN r.status='Pending' THEN 1 ELSE 0 END) AS pending_count
      FROM users u LEFT JOIN organizations o ON o.id=u.organization_id
      LEFT JOIN leave_requests r ON r.employee_id=u.id
      WHERE u.organization_id=? AND u.manager_id=? AND u.role='employee'
      GROUP BY u.id,o.name ORDER BY LOWER(u.name)`, req.user.organizationId, req.user.id);
    res.json(people.map(person => ({ ...publicUser(person), requestCount: Number(person.request_count) || 0, pendingCount: Number(person.pending_count) || 0 })));
  } catch (error) { next(error); }
});
app.get('/api/organization', auth, role('manager'), async (req, res, next) => {
  try {
    const organization = await db.get('SELECT name,employee_invite_code AS "employeeInviteCode",manager_invite_code AS "managerInviteCode" FROM organizations WHERE id=?', req.user.organizationId);
    res.json(organization || {});
  } catch (error) { next(error); }
});
app.get('/api/my-manager', auth, role('employee'), async (req, res, next) => {
  try {
    const manager = req.user.managerId ? await db.get("SELECT u.*,o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE u.id=? AND u.role='manager'", req.user.managerId) : null;
    res.json({ manager: publicUser(manager) });
  } catch (error) { next(error); }
});

app.get('/api/profile-requests', auth, async (req, res, next) => {
  try {
    const rows = req.user.role === 'manager'
      ? await db.all('SELECT p.*,e.name AS employee_name,e.email AS employee_email,e.team FROM profile_requests p JOIN users e ON e.id=p.employee_id WHERE p.manager_id=? ORDER BY p.submitted_at DESC', req.user.id)
      : await db.all('SELECT p.*,e.name AS employee_name,e.email AS employee_email,e.team FROM profile_requests p JOIN users e ON e.id=p.employee_id WHERE p.employee_id=? ORDER BY p.submitted_at DESC', req.user.id);
    res.json(rows.map(publicProfileRequest));
  } catch (error) { next(error); }
});
app.post('/api/profile-requests', auth, role('employee'), async (req, res, next) => {
  try {
    const input = req.body?.changes;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Enter the profile details you want to change.' });
    const allowed = ['name', 'email', 'phone'];
    const keys = Object.keys(input);
    if (!keys.length || keys.some(key => !allowed.includes(key))) return res.status(400).json({ error: 'Only your name, email, and WhatsApp number can be changed here.' });
    const changes = {};
    for (const key of keys) {
      const value = String(input[key] || '').trim();
      if (key === 'name') { if (value.length < 2 || value.length > 80) return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' }); changes.name = value; }
      if (key === 'email') { const email = value.toLowerCase(); if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' }); if (await db.get('SELECT id FROM users WHERE LOWER(email)=LOWER(?) AND id<>?', email, req.user.id)) return res.status(409).json({ error: 'That email is already used by another account.' }); changes.email = email; }
      if (key === 'phone') { const phone = cleanPhone(value); if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter a WhatsApp number with country code.' }); changes.phone = phone; }
    }
    for (const key of Object.keys(changes)) if (changes[key] === req.user[key]) delete changes[key];
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'The details are unchanged.' });
    if (await db.get("SELECT id FROM profile_requests WHERE employee_id=? AND status='Pending'", req.user.id)) return res.status(409).json({ error: 'You already have a profile change waiting for manager review.' });
    const id = randomUUID();
    await db.run('INSERT INTO profile_requests(id,employee_id,manager_id,changes_json,submitted_at) VALUES(?,?,?,?,?)', id, req.user.id, req.user.managerId, JSON.stringify(changes), new Date().toISOString());
    const row = await db.get('SELECT p.*,e.name AS employee_name,e.email AS employee_email,e.team FROM profile_requests p JOIN users e ON e.id=p.employee_id WHERE p.id=?', id);
    broadcast([req.user.managerId], { type: 'refresh', reason: 'profile-change-request' });
    res.status(201).json(publicProfileRequest(row));
  } catch (error) { next(error); }
});
app.post('/api/profile-requests/:id/decision', auth, role('manager'), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '');
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
    const row = await db.get('SELECT p.*,e.name AS employee_name,e.email AS employee_email,e.team FROM profile_requests p JOIN users e ON e.id=p.employee_id WHERE p.id=? AND p.manager_id=?', req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Profile request not found for your team.' });
    if (row.status !== 'Pending') return res.status(409).json({ error: 'This profile request has already been reviewed.' });
    const changes = JSON.parse(row.changes_json);
    if (decision === 'Approved') {
      if (changes.email && await db.get('SELECT id FROM users WHERE LOWER(email)=LOWER(?) AND id<>?', changes.email, row.employee_id)) return res.status(409).json({ error: 'That email is now used by another account. Ask the employee to submit a different one.' });
      const fields = Object.keys(changes);
      const columns = { name: 'name', email: 'email', phone: 'phone' };
      await db.run(`UPDATE users SET ${fields.map(field => `${columns[field]}=?`).join(',')} WHERE id=?`,
        ...fields.map(field => changes[field]), row.employee_id);
    }
    const note = String(req.body?.note || '').trim().slice(0, 300) || null;
    const update = await db.run("UPDATE profile_requests SET status=?,reviewed_at=?,review_note=? WHERE id=? AND manager_id=? AND status='Pending'", decision, new Date().toISOString(), note, row.id, req.user.id);
    if (update.changes !== 1) return res.status(409).json({ error: 'This profile request was just reviewed.' });
    const updated = await db.get('SELECT p.*,e.name AS employee_name,e.email AS employee_email,e.team FROM profile_requests p JOIN users e ON e.id=p.employee_id WHERE p.id=?', row.id);
    broadcast([row.employee_id, req.user.id], { type: 'refresh', reason: 'profile-change-decision' });
    res.json(publicProfileRequest(updated));
  } catch (error) { next(error); }
});

app.get('/api/leave-requests', auth, async (req, res, next) => {
  try {
    const rows = req.user.role === 'manager'
      ? await db.all('SELECT r.*,e.name AS employee_name,e.team,m.name AS manager_name FROM leave_requests r JOIN users e ON e.id=r.employee_id JOIN users m ON m.id=r.manager_id WHERE r.manager_id=? ORDER BY r.submitted_at DESC', req.user.id)
      : await db.all('SELECT r.*,e.name AS employee_name,e.team,m.name AS manager_name FROM leave_requests r JOIN users e ON e.id=r.employee_id JOIN users m ON m.id=r.manager_id WHERE r.employee_id=? ORDER BY r.submitted_at DESC', req.user.id);
    res.json(await Promise.all(rows.map(row => publicRequest(row, req.user.id))));
  } catch (error) { next(error); }
});
app.post('/api/leave-requests', auth, role('employee'), async (req, res, next) => {
  try {
    const { type, startDate, endDate, reason } = req.body || {};
    if (!['Annual leave', 'Personal day', 'Sick leave', 'Unpaid leave'].includes(type)) return res.status(400).json({ error: 'Choose a valid leave type.' });
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return res.status(400).json({ error: 'Enter valid start and end dates.' });
    if (startDate < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Leave cannot start in the past.' });
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) return res.status(400).json({ error: 'Add a reason between 5 and 500 characters.' });
    const days = weekdays(startDate, endDate);
    if (!days) return res.status(400).json({ error: 'Choose at least one weekday.' });
    const id = randomUUID();
    const validation = await withTransaction(async tx => {
      // SQLite's BEGIN IMMEDIATE already serializes writers. Lock the employee row
      // in Postgres so simultaneous submissions cannot both pass the overlap or
      // annual allowance checks.
      if (databaseKind === 'postgres') await tx.get('SELECT id FROM users WHERE id=? FOR UPDATE', req.user.id);
      const collision = await tx.get("SELECT status FROM leave_requests WHERE employee_id=? AND status IN('Pending','Approved') AND start_date<=? AND end_date>=? LIMIT 1", req.user.id, endDate, startDate);
      if (collision) return { error: `These dates overlap a ${collision.status.toLowerCase()} request.`, status: 409 };
      if (type === 'Annual leave') {
        const used = Number((await tx.get("SELECT COALESCE(SUM(days),0) AS days FROM leave_requests WHERE employee_id=? AND leave_type='Annual leave' AND status IN('Pending','Approved')", req.user.id)).days);
        if (used + days > req.user.leaveDays) return { error: `This request exceeds your remaining annual leave (${Math.max(0, req.user.leaveDays - used)} days).`, status: 400 };
      }
      await tx.run("INSERT INTO leave_requests(id,employee_id,manager_id,leave_type,start_date,end_date,days,reason,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)", id, req.user.id, req.user.managerId, type, startDate, endDate, days, reason.trim(), new Date().toISOString());
      return null;
    });
    if (validation) return res.status(validation.status).json({ error: validation.error });
    const manager = await db.get('SELECT * FROM users WHERE id=?', req.user.managerId);
    const range = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const message = `${req.user.name} requested ${type} for ${range} (${days} working days). Reason: ${reason.trim()}`;
    const notifications = await sendNotifications({ user: manager, message, parameters: [manager.name, `${req.user.name} requested ${type}`, range] });
    await saveNotifications(id, manager.id, notifications);
    broadcast([manager.id], { type: 'refresh', reason: 'leave-request' });
    res.status(201).json(await publicRequest(await findRequest(id), req.user.id));
  } catch (error) { next(error); }
});
app.post('/api/leave-requests/:id/retry-email', auth, async (req, res, next) => {
  try {
    const request = await db.get('SELECT * FROM leave_requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Leave request not found.' });
    let recipientId;
    if (req.user.id === request.employee_id) recipientId = request.manager_id;
    else if (req.user.id === request.manager_id && request.status !== 'Pending') recipientId = request.employee_id;
    else return res.status(403).json({ error: 'You cannot retry this notification.' });
    const latest = await db.get("SELECT recipient,message,delivery_status FROM notifications WHERE request_id=? AND recipient_user_id=? AND channel='Email' ORDER BY created_at DESC LIMIT 1", request.id, recipientId);
    if (!latest) return res.status(404).json({ error: 'There is no email notification to retry yet.' });
    if (latest.delivery_status !== 'failed') return res.status(409).json({ error: 'Only a failed email can be retried.' });
    const notification = await sendEmailNotification(latest.recipient, latest.message);
    await saveNotifications(request.id, recipientId, [notification]);
    broadcast([request.employee_id, request.manager_id], { type: 'refresh', reason: 'email-retry' });
    res.json(await publicRequest(await findRequest(request.id), req.user.id));
  } catch (error) { next(error); }
});
app.post('/api/leave-requests/:id/decision', auth, role('manager'), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '');
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
    const request = await db.get(`SELECT r.*,e.name AS employee_name,e.email,e.phone,e.team,m.name AS manager_name
      FROM leave_requests r JOIN users e ON e.id=r.employee_id JOIN users m ON m.id=r.manager_id
      WHERE r.id=? AND r.manager_id=?`, req.params.id, req.user.id);
    if (!request) return res.status(404).json({ error: 'Request not found for your team.' });
    if (request.status !== 'Pending') return res.status(409).json({ error: 'This request has already been reviewed.' });
    const reviewedAt = new Date().toISOString();
    const update = await db.run("UPDATE leave_requests SET status=?,reviewed_at=?,reviewed_by=? WHERE id=? AND manager_id=? AND status='Pending'", decision, reviewedAt, req.user.id, request.id, req.user.id);
    if (update.changes !== 1) return res.status(409).json({ error: 'This request was already reviewed.' });
    const range = request.start_date === request.end_date ? request.start_date : `${request.start_date} to ${request.end_date}`;
    const message = `${request.employee_name}, your ${request.leave_type.toLowerCase()} request for ${range} was ${decision.toLowerCase()} by ${req.user.name}.`;
    const notifications = await sendNotifications({ user: { email: request.email, phone: request.phone }, message, parameters: [request.employee_name, `your leave request was ${decision.toLowerCase()}`, range] });
    await saveNotifications(request.id, request.employee_id, notifications);
    broadcast([request.employee_id, request.manager_id], { type: 'refresh', reason: 'leave-decision' });
    res.json({ ...await publicRequest(await findRequest(request.id), req.user.id), employeeNotificationStatus: notifications.map(({ channel, deliveryStatus }) => ({ channel, deliveryStatus })) });
  } catch (error) { next(error); }
});

if (process.env.NODE_ENV === 'production') app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist')));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, _req, res, _next) => {
  console.error('[API error]', error);
  const message = process.env.NODE_ENV === 'production' ? 'The server could not complete that action. Please try again.' : `Local server error: ${error instanceof Error ? error.message : 'Unknown server error'}`;
  res.status(500).json({ error: message });
});

const server = createServer(app);
async function authenticateRealtime(request) {
  const token = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const row = await db.get('SELECT s.expires_at,u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', hash(decodeURIComponent(token)));
  return row && row.expires_at > new Date().toISOString() ? row.id : null;
}
broadcast = attachRealtime(server, authenticateRealtime, allowedOrigins);

await initializeDatabase();
server.listen(port, host, () => console.log(`ELMS API ready at http://${host}:${port} (${databaseKind})`));
function shutdown() { server.close(async () => { await db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
