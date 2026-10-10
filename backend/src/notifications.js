import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';

const timeout = 10000;

const missing = (channel, recipient, message) => ({
  channel,
  recipient: recipient || 'Not configured',
  message,
  deliveryStatus: 'not_configured',
  statusNote: `Add the ${channel} provider settings in backend/.env.`,
  createdAt: new Date().toISOString()
});

const failed = (channel, recipient, message, note) => ({
  channel,
  recipient,
  message,
  deliveryStatus: 'failed',
  statusNote: note,
  createdAt: new Date().toISOString()
});

async function email(to, message) {
  const {
    GMAIL_USER,
    GMAIL_APP_PASSWORD,
    GMAIL_SMTP_HOST = 'smtp.gmail.com',
    GMAIL_SMTP_PORT = '465',
    RESEND_API_KEY,
    EMAIL_FROM
  } = process.env;

  if (!to) return missing('Email', to, message);

  if (GMAIL_USER || GMAIL_APP_PASSWORD) {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return failed('Email', to, message, 'Add both GMAIL_USER and GMAIL_APP_PASSWORD to backend/.env.');
    }

    const preferredPort = Number(GMAIL_SMTP_PORT) || 587;
    const ports = [preferredPort, ...(preferredPort === 465 ? [587] : [465])];
    let lastError;

    for (const port of ports) {
      try {
        const transporter = nodemailer.createTransport({
          host: GMAIL_SMTP_HOST,
          port,
          secure: port === 465,
          requireTLS: port === 587,
          auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') },
          connectionTimeout: timeout,
          greetingTimeout: timeout,
          socketTimeout: timeout
        });

        await transporter.sendMail({
          from: `ELMS <${GMAIL_USER}>`,
          to,
          subject: 'Employee leave update',
          text: message
        });

        return {
          channel: 'Email',
          recipient: to,
          message,
          deliveryStatus: 'accepted',
          statusNote: `Accepted by Gmail over port ${port}; delivery may still be delayed or filtered.`,
          createdAt: new Date().toISOString()
        };
      } catch (error) {
        lastError = error;
        if (error.code === 'EAUTH') {
          return failed('Email', to, message, 'Gmail rejected the sign-in. Check the Gmail address and App Password.');
        }

        if (port === ports.at(-1) || !['CONN', 'EHLO', 'STARTTLS'].includes(error.command)) break;
      }
    }

    const error = lastError || {};
    const code = String(error.code || 'unknown error').slice(0, 24);
    const command = String(error.command || 'connection').slice(0, 24);
    const note = error.code === 'ETIMEDOUT' || error.code === 'ESOCKET'
      ? `Gmail secure SMTP connection failed (${code}, ${command}). The app tries ports 587 and 465 when the failure is before message delivery. Check firewall/VPN security and retry.`
      : `Gmail could not send this email (${code}, ${command}). Check the mail settings in backend/.env.`;

    return failed('Email', to, message, note);
  }

  if (!RESEND_API_KEY || !EMAIL_FROM) return missing('Email', to, message);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID()
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: 'Employee leave update',
        text: message
      }),
      signal: AbortSignal.timeout(timeout)
    });

    const data = await response.json().catch(() => ({}));

    return response.ok
      ? {
          channel: 'Email',
          recipient: to,
          message,
          deliveryStatus: 'accepted',
          statusNote: 'Accepted by Resend; final delivery confirmation is not connected.',
          createdAt: new Date().toISOString()
        }
      : failed('Email', to, message, data.message || `Email provider returned HTTP ${response.status}.`);
  } catch (error) {
    return failed('Email', to, message, error.name === 'TimeoutError' ? 'Email provider timed out.' : 'Could not reach email provider.');
  }
}

export async function sendEmailNotification(to, message) {
  return { id: randomUUID(), ...(await email(to, message)) };
}

async function whatsapp(to, message, parameters) {
  const {
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_API_VERSION,
    WHATSAPP_TEMPLATE_NAME,
    WHATSAPP_TEMPLATE_LANGUAGE = 'en_US'
  } = process.env;

  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_API_VERSION || !WHATSAPP_TEMPLATE_NAME || !to) {
    return missing('WhatsApp', to, message);
  }

  try {
    const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/\D/g, ''),
        type: 'template',
        template: {
          name: WHATSAPP_TEMPLATE_NAME,
          language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
          components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }]
        }
      }),
      signal: AbortSignal.timeout(timeout)
    });

    const data = await response.json().catch(() => ({}));

    return response.ok
      ? {
          channel: 'WhatsApp',
          recipient: to,
          message,
          deliveryStatus: 'accepted',
          statusNote: 'Accepted by WhatsApp Cloud API; final delivery confirmation is not connected.',
          createdAt: new Date().toISOString()
        }
      : failed('WhatsApp', to, message, data.error?.message || `WhatsApp provider returned HTTP ${response.status}.`);
  } catch (error) {
    return failed('WhatsApp', to, message, error.name === 'TimeoutError' ? 'WhatsApp provider timed out.' : 'Could not reach WhatsApp Cloud API.');
  }
}

export async function sendNotifications({ user, message, parameters }) {
  const items = await Promise.all([email(user.email, message), whatsapp(user.phone, message, parameters)]);
  return items.map((item) => ({ id: randomUUID(), ...item }));
}
