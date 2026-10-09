import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
mkdirSync(directory, { recursive: true });
export const db = new DatabaseSync(path.join(directory, 'elms.sqlite'));
db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL, team TEXT NOT NULL DEFAULT 'General',
    role TEXT NOT NULL CHECK(role IN ('employee','manager')),
    manager_id TEXT REFERENCES users(id), leave_days INTEGER NOT NULL DEFAULT 24,
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
export function publicUser(user) {
  if (!user) return null;
  return { id:user.id, name:user.name, email:user.email, phone:user.phone, role:user.role,
    team:user.team, managerId:user.manager_id, leaveDays:user.leave_days || 24 };
}
export function findRequest(id) {
  return db.prepare(`SELECT r.*, e.name AS employee_name, e.team, m.name AS manager_name
    FROM leave_requests r JOIN users e ON e.id=r.employee_id
    JOIN users m ON m.id=r.manager_id WHERE r.id=?`).get(id);
}
export function publicRequest(row, viewerId) {
  const notificationsFor = recipientId => db.prepare('SELECT id, channel, recipient, message, delivery_status AS deliveryStatus, status_note AS statusNote, created_at AS createdAt FROM notifications WHERE request_id=? AND recipient_user_id=? ORDER BY created_at').all(row.id, recipientId);
  return { id:row.id, employeeId:row.employee_id, employeeName:row.employee_name,
    team:row.team, type:row.leave_type, startDate:row.start_date, endDate:row.end_date,
    days:row.days, reason:row.reason, status:row.status, submittedAt:row.submitted_at,
    reviewedAt:row.reviewed_at, reviewedBy:row.manager_name,
    notifications:notificationsFor(viewerId),
    ...(viewerId===row.manager_id?{employeeNotifications:notificationsFor(row.employee_id)}:{managerNotifications:notificationsFor(row.manager_id)}) };
}
export function publicProfileRequest(row) {
  return { id:row.id, employeeId:row.employee_id, employeeName:row.employee_name,
    employeeEmail:row.employee_email, team:row.team, changes:JSON.parse(row.changes_json),
    status:row.status, submittedAt:row.submitted_at, reviewedAt:row.reviewed_at,
    reviewNote:row.review_note };
}
