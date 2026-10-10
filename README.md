# Employee Leave Management System (ELMS)

A beginner-friendly college project based on the supplied mini-project report. Managers create an organization workspace and share employee or manager invite codes. Employees join a workspace before choosing a manager, and each organization's requests and people are kept separate. Local development uses SQLite; hosted deployments can use PostgreSQL. Email and WhatsApp notifications are optional integrations.

## Technologies used

- **React** for interactive screens
- **HTML (JSX) and CSS** for page structure and responsive design
- **JavaScript with Node.js and Express** for the server and application rules
- **SQLite or PostgreSQL** for employee, manager, session, leave, and notification tables
- **Authenticated WebSocket** updates so connected dashboards refresh when requests change
- **Gmail, Resend, and Meta WhatsApp Cloud API** adapters for notifications after credentials are configured

## Requirements

- Node.js 24 or newer (the SQLite fallback uses Node's built-in `node:sqlite` module)
- npm

## Run from VS Code

1. In VS Code choose **File → Open Folder** and select this project folder.
2. Open **Terminal → New Terminal**.
3. Run `npm install` once.
4. Run `npm run dev` and leave that terminal open.
5. Open `http://127.0.0.1:5173/` after both the API and Vite report that they are ready. If either port is already in use, stop the earlier ELMS server before starting another. The frontend is set to fail clearly instead of silently choosing a different port and showing an older app instance.

The API health page is `http://localhost:4000/api/health`.

The frontend also opens an authenticated WebSocket to the API. When a leave request is submitted or approved/rejected, connected employee and manager dashboards refresh automatically. The Vite proxy forwards both API calls and WebSocket connections to the local backend.

## Try the project

1. Choose **Create account** and select **Manager**.
2. Create a workspace by entering your college or company name.
3. Sign in as the manager, open **My team**, and share the employee invite code.
4. Create an **Employee** account, enter the employee code, choose **Find my workspace**, then select that workspace's manager.
5. Sign in as the employee and submit a leave request. The app counts Monday–Friday as leave days and checks overlapping requests and annual leave allowance.
6. Sign out and sign in as the manager to approve or reject the request.
7. Both roles can see the email status for their side of the workflow. Employees can retry a failed manager notification from **My requests**; managers can retry a failed decision email from **Approvals → Recent decisions**. Retrying does not create another leave request.

Managers can share the separate manager invite code with trusted managers. Treat both workspace codes as private, especially the manager code. Existing local accounts are automatically grouped into a **College project workspace** when the database is upgraded; its invite codes appear on the manager's **My team** page.

Use phone numbers with a leading country code, such as `+91 9876543210`. The database is created automatically at `backend/data/elms.sqlite` and remains on this computer between runs.

## Using multiple workspaces

Each workspace has its own employees, managers, leave requests, and generated invitation codes. The app checks the invite code and selected manager on the server, so an employee cannot join a different workspace by changing the browser form. Keep invite codes private. PostgreSQL is supported for hosted deployments. Keep the realtime backend on one instance; multiple backend instances need a shared realtime service before scaling horizontally.

For a private online demo, build the frontend with `npm run build`, set `NODE_ENV=production` and `HOST=0.0.0.0` on the server, and start the backend with `npm start`. The hosting service must provide a persistent disk for `backend/data/elms.sqlite` and HTTPS in front of the app. The development server itself is not a public website. Before opening registration broadly, add email verification and abuse protections, and replace any demo provider credentials with private production credentials.

## Email and WhatsApp

The leave workflow works without provider settings and records notifications as **Not configured**. For a college demo, email can use a Gmail account without owning a website domain:

1. Turn on 2-Step Verification for the Gmail account you want to send from.
2. Create a Google App Password for this project. Use that app password, not your normal Gmail password.
3. In `backend/.env`, fill in `GMAIL_USER` with the sending Gmail address and `GMAIL_APP_PASSWORD` with the app password. Keep the app password private.
4. Restart the development servers. The app emails the assigned manager when an employee submits a request and emails the employee after the manager approves or rejects it. Gmail uses SMTP port 587 (STARTTLS) by default and can fall back to port 465 (TLS) when the connection fails before sending the message.

Google requires 2-Step Verification to create App Passwords, and some school or protected accounts may not offer that option. If it is unavailable, use an account that allows App Passwords or configure Resend with a verified domain. [Google App Password instructions](https://support.google.com/accounts/answer/185833)

To enable real WhatsApp messages, set up a Meta WhatsApp Cloud API sender and an approved message template with three text placeholders. Then fill in `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_NAME`, and (if needed) `WHATSAPP_TEMPLATE_LANGUAGE` in `backend/.env`.

Keep `backend/.env` private. Never put provider keys in frontend files or share them in chat. **Accepted** means the provider accepted the send request; it does not confirm that the message reached the recipient's inbox or phone.

## Project layout

```text
  backend/src/server.js       Express API, registration, sessions, requests, approvals
  backend/src/db.js           SQLite/Postgres database adapters and public data views
  backend/src/migrate-sqlite-to-postgres.js Guarded one-time local data migration
  backend/src/notifications.js Resend and WhatsApp Cloud API adapters
  backend/src/realtime.js     Authenticated WebSocket updates for connected dashboards
backend/data/               Created automatically for the local database
frontend/src/App.jsx        Login, registration, dashboard, calendar, team, requests
frontend/src/styles.css     Responsive design
frontend/vite.config.js     Vite server and API proxy
```

## Useful commands

- `npm run dev` — run the frontend and API together
- `npm run dev:frontend` — run only the frontend
- `npm run dev:backend` — run only the API
- `npm run build` — build the frontend for production
- `npm start` — run the API without file watching

## Hosted deployment (Vercel frontend + persistent API host)

The backend supports managed PostgreSQL through `DATABASE_URL`; without it, local development continues to use SQLite. Do not use the local SQLite file as the hosted database.

1. Create an empty PostgreSQL database with a provider such as Neon, Supabase, Render, or Railway. Keep its connection URL private.
2. Before deploying, set `DATABASE_URL` in the backend host's private environment settings, then copy local data if needed by running `npm run migrate:postgres` from your computer with that URL in `backend/.env`. The migration refuses to copy into non-empty tables and leaves the SQLite file unchanged. If starting fresh, skip this command.
3. Deploy the backend as a persistent Node service (Render or Railway). Set `NODE_ENV=production`, `HOST=0.0.0.0`, `DATABASE_URL`, and `ALLOWED_ORIGINS` to the exact Vercel site origin, such as `https://your-project.vercel.app`. Add email/WhatsApp provider settings there if notifications are needed. Keep secrets in the host's environment settings, never in Git.
4. Import the GitHub repository into Vercel. The included `vercel.json` builds the frontend from the repository root. Set `VITE_API_BASE_URL` to the backend's HTTPS origin (no trailing slash), then deploy.
5. Verify account creation/login, employee request submission, manager approval/rejection, notifications, and live dashboard updates before sharing the site. Keep the backend on one instance for realtime notifications; use a shared realtime service before scaling it horizontally.

The manager who creates a workspace does not need a `MANAGER_INVITE_CODE`; the app generates a private employee invite code for that workspace. The invitation codes are available in the manager's **My team** page.

This remains a learning project and does not include email/phone verification, password reset links, holiday calendars, or production monitoring. Keep registration limited until those safeguards are added.

## Reset a forgotten password (local project)

If a local demo account password is forgotten, open a VS Code terminal at the project root and run `npm run reset-password`. Enter the account email, then type and confirm a new password of at least 10 characters. The password is hidden while typing. This local recovery command is intended for the project owner on this computer; do not run it on a shared/production server.
