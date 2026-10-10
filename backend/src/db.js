import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
mkdirSync(directory, { recursive: true });
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
const postgresUrl = process.env.DATABASE_URL;
const sqlite = postgresUrl ? null : new DatabaseSync(path.join(directory, 'elms.sqlite'));
let pool = null;
export const databaseKind = postgresUrl ? 'postgres' : 'sqlite';

const postgresSchema = `
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    employee_invite_code TEXT NOT NULL UNIQUE,
    manager_invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
    phone TEXT NOT NULL, team TEXT NOT NULL DEFAULT 'General',
    role TEXT NOT NULL CHECK(role IN ('employee','manager')),
    manager_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id),
    leave_days INTEGER NOT NULL DEFAULT 24, salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users(LOWER(email));
  CREATE INDEX IF NOT EXISTS users_organization_idx ON users(organization_id,role,manager_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES users(id),
    manager_id TEXT NOT NULL REFERENCES users(id), leave_type TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, days INTEGER NOT NULL CHECK(days>0),
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending'
      CHECK(status IN ('Pending','Approved','Rejected')),
    submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS request_employee_idx ON leave_requests(employee_id, submitted_at);
  CREATE INDEX IF NOT EXISTS request_manager_idx ON leave_requests(manager_id, status, start_date);
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
    recipient TEXT NOT NULL, message TEXT NOT NULL,
    delivery_status TEXT NOT NULL CHECK(delivery_status IN ('not_configured','failed','accepted')),
    status_note TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manager_id TEXT NOT NULL REFERENCES users(id), changes_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
    submitted_at TEXT NOT NULL, reviewed_at TEXT, review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS profile_request_manager_idx ON profile_requests(manager_id,status,submitted_at);
`;

export async function initializeDatabase() {
  if (postgresUrl) {
    pool = new Pool({ connectionString: postgresUrl, ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }, max: 10 });
    await pool.query(postgresSchema);
    const legacyUsers = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE organization_id IS NULL');
    if (legacyUsers.rows[0].count) {
      let organization = (await pool.query('SELECT * FROM organizations ORDER BY created_at LIMIT 1')).rows[0];
      if (!organization) {
        organization = { id: randomUUID() };
        await pool.query('INSERT INTO organizations(id,name,employee_invite_code,manager_invite_code,created_at) VALUES($1,$2,$3,$4,$5)', [organization.id, 'Imported workspace', randomBytes(18).toString('base64url'), randomBytes(24).toString('base64url'), new Date().toISOString()]);
      }
      await pool.query('UPDATE users SET organization_id=$1 WHERE organization_id IS NULL', [organization.id]);
    }
    return;
  }
  sqlite.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    employee_invite_code TEXT NOT NULL UNIQUE,
    manager_invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL, team TEXT NOT NULL DEFAULT 'General',
    role TEXT NOT NULL CHECK(role IN ('employee','manager')),
    manager_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id), leave_days INTEGER NOT NULL DEFAULT 24,
    salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES users(id),
    manager_id TEXT NOT NULL REFERENCES users(id), leave_type TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, days INTEGER NOT NULL CHECK(days>0),
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending'
      CHECK(status IN ('Pending','Approved','Rejected')),
    submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS request_employee_idx ON leave_requests(employee_id, submitted_at);
  CREATE INDEX IF NOT EXISTS request_manager_idx ON leave_requests(manager_id, status, start_date);
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
    recipient TEXT NOT NULL, message TEXT NOT NULL,
    delivery_status TEXT NOT NULL CHECK(delivery_status IN ('not_configured','failed','accepted')),
    status_note TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manager_id TEXT NOT NULL REFERENCES users(id), changes_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
    submitted_at TEXT NOT NULL, reviewed_at TEXT, review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS profile_request_manager_idx ON profile_requests(manager_id,status,submitted_at);
`);
  const userColumns = sqlite.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('organization_id')) sqlite.exec('ALTER TABLE users ADD COLUMN organization_id TEXT REFERENCES organizations(id)');
  const legacyUsers = sqlite.prepare('SELECT COUNT(*) AS count FROM users WHERE organization_id IS NULL').get().count;
  if (legacyUsers) {
  let organization = sqlite.prepare('SELECT * FROM organizations ORDER BY created_at LIMIT 1').get();
  if(!organization){
    const id=randomUUID(),now=new Date().toISOString();
    sqlite.prepare('INSERT INTO organizations(id,name,employee_invite_code,manager_invite_code,created_at) VALUES(?,?,?,?,?)')
      .run(id,'College project workspace',randomBytes(18).toString('base64url'),randomBytes(24).toString('base64url'),now);
    organization={id};
  }
  sqlite.prepare('UPDATE users SET organization_id=? WHERE organization_id IS NULL').run(organization.id);
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS users_organization_idx ON users(organization_id,role,manager_id)');
}

function postgresSql(sql) {
  let parameterIndex = 0;
  return sql.replace(/email\s*=\s*\?\s+COLLATE NOCASE/gi, 'LOWER(email)=LOWER(?)')
    .replace(/ORDER BY\s+([\w.]+)\s+COLLATE NOCASE/gi, 'ORDER BY LOWER($1)')
    .replace(/\?/g, () => `$${++parameterIndex}`);
}

export const db = {
  async get(sql, ...params) {
    if (!postgresUrl) return sqlite.prepare(sql).get(...params);
    return (await pool.query(postgresSql(sql), params)).rows[0];
  },
  async all(sql, ...params) {
    if (!postgresUrl) return sqlite.prepare(sql).all(...params);
    return (await pool.query(postgresSql(sql), params)).rows;
  },
  async run(sql, ...params) {
    if (!postgresUrl) return sqlite.prepare(sql).run(...params);
    const result = await pool.query(postgresSql(sql), params);
    return { changes: result.rowCount };
  },
  async exec(sql) {
    if (!postgresUrl) return sqlite.exec(sql);
    return pool.query(sql);
  },
  async close() {
    if (postgresUrl) await pool?.end();
    else sqlite.close();
  },
};

export async function withTransaction(callback) {
  if (!postgresUrl) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await callback(db); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  const client = await pool.connect();
  const scoped = {
    get: async (sql, ...params) => (await client.query(postgresSql(sql), params)).rows[0],
    all: async (sql, ...params) => (await client.query(postgresSql(sql), params)).rows,
    run: async (sql, ...params) => ({ changes: (await client.query(postgresSql(sql), params)).rowCount }),
    exec: sql => client.query(sql),
  };
  try { await client.query('BEGIN'); const result = await callback(scoped); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function migrateSqliteToPostgres(sourcePath = path.join(directory, 'elms.sqlite')) {
  if (!postgresUrl) throw new Error('Set DATABASE_URL to the empty hosted Postgres database before migrating.');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const tables = ['organizations', 'users', 'sessions', 'leave_requests', 'notifications', 'profile_requests'];
  try {
    for (const table of tables) {
      const result = await db.get(`SELECT COUNT(*)::int AS count FROM ${table}`);
      if (result.count !== 0) throw new Error(`Target table "${table}" is not empty; migration stopped without copying data.`);
    }
    const counts = {};
    await withTransaction(async tx => {
      for (const table of tables) {
        const rows = source.prepare(`SELECT * FROM ${table}`).all();
        counts[table] = rows.length;
        for (const row of rows) {
          const columns = Object.keys(row);
          const placeholders = columns.map(() => '?').join(',');
          await tx.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders})`, ...columns.map(column => row[column]));
        }
      }
    });
    return counts;
  } finally { source.close(); }
}

export function publicUser(user) {
  if (!user) return null;
  return { id:user.id, name:user.name, email:user.email, phone:user.phone, role:user.role,
    team:user.team, managerId:user.manager_id, organizationId:user.organization_id,
    organizationName:user.organization_name||null, leaveDays:user.leave_days || 24 };
}
export async function findRequest(id) {
  return db.get(`SELECT r.*, e.name AS employee_name, e.team, m.name AS manager_name
    FROM leave_requests r JOIN users e ON e.id=r.employee_id
    JOIN users m ON m.id=r.manager_id WHERE r.id=?`, id);
}
export async function publicRequest(row, viewerId) {
  const notificationsFor = recipientId => db.all('SELECT id, channel, recipient, message, delivery_status AS "deliveryStatus", status_note AS "statusNote", created_at AS "createdAt" FROM notifications WHERE request_id=? AND recipient_user_id=? ORDER BY created_at', row.id, recipientId);
  return { id:row.id, employeeId:row.employee_id, employeeName:row.employee_name,
    team:row.team, type:row.leave_type, startDate:row.start_date, endDate:row.end_date,
    days:row.days, reason:row.reason, status:row.status, submittedAt:row.submitted_at,
    reviewedAt:row.reviewed_at, reviewedBy:row.manager_name,
    notifications:await notificationsFor(viewerId),
    ...(viewerId===row.manager_id?{employeeNotifications:await notificationsFor(row.employee_id)}:{managerNotifications:await notificationsFor(row.manager_id)}) };
}
export function publicProfileRequest(row) {
  return { id:row.id, employeeId:row.employee_id, employeeName:row.employee_name,
    employeeEmail:row.employee_email, team:row.team, changes:JSON.parse(row.changes_json),
    status:row.status, submittedAt:row.submitted_at, reviewedAt:row.reviewed_at,
    reviewNote:row.review_note };
}
