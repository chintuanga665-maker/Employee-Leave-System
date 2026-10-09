# Employee Leave Management System (ELMS)

A beginner-friendly college project based on the supplied mini-project report. Employees create an account, request leave, track decisions, and send profile changes to their manager for review. Managers review leave and profile requests for assigned employees. The app stores its data in a local SQL database and has integration points for email and WhatsApp notifications.

## Technologies used

- **React** for interactive screens
- **HTML (JSX) and CSS** for page structure and responsive design
- **JavaScript with Node.js and Express** for the server and application rules
- **SQLite SQL database** for employee, manager, session, leave, and notification tables
- **Authenticated WebSocket** updates so connected dashboards refresh when requests change
- **Resend and Meta WhatsApp Cloud API** adapters for real notification delivery after credentials are configured

## Requirements

- Node.js 25.7 or newer (Node 26 recommended for its built-in SQLite module)
- npm

## Run from VS Code

1. In VS Code choose **File → Open Folder** and select this project folder.
2. Open **Terminal → New Terminal**.
3. Run `npm install` once.
4. Run `npm run dev` and leave that terminal open.
5. Open the `Local` address Vite prints in the terminal. Vite may choose another port if 5173 is busy; use the printed address.

The API health page is `http://localhost:4000/api/health`.

The frontend also opens an authenticated WebSocket to the API. When a leave request is submitted or approved/rejected, connected employee and manager dashboards refresh automatically. The Vite proxy forwards both API calls and WebSocket connections to the local backend.

## Try the project

1. Choose **Create account** and select **Manager**.
2. Enter the local demo invitation code `elms-college-demo`.
3. Sign out, create an **Employee** account, and select that manager.
4. Sign in as the employee and submit a leave request. The app counts Monday–Friday as leave days and checks overlapping requests and annual leave allowance.
5. Sign out and sign in as the manager to approve or reject the request.
6. Both roles can see the email status for their side of the workflow. Employees can retry a failed manager notification from **My requests**; managers can retry a failed decision email from **Approvals → Recent decisions**. Retrying does not create another leave request.

Use phone numbers with a leading country code, such as `+91 9876543210`. The database is created automatically at `backend/data/elms.sqlite` and remains on this computer between runs.

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
  backend/src/db.js           SQLite tables and safe public data
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

This is a local learning project. It does not yet include email/phone verification, password reset, holiday calendars, or production deployment setup.

## Reset a forgotten password (local project)

If a local demo account password is forgotten, open a VS Code terminal at the project root and run `npm run reset-password`. Enter the account email, then type and confirm a new password of at least 10 characters. The password is hidden while typing. This local recovery command is intended for the project owner on this computer; do not run it on a shared/production server.
