// Cloudflare Worker: brimwood-introduction
// Route: brimwoodinnovation.com/api/*
// Brimwood's own email hub. Sends branded emails via Resend (free tier).
// API key lives in the Worker secret RESEND_API_KEY.
// Newsletter subscribers live in the KV binding NEWSLETTER.
//
// Endpoints:
//   POST /api/introduction          — introduction request form
//   POST /api/newsletter            — newsletter signup (sends double opt-in)
//   GET  /api/newsletter/verify     — confirm subscription (?token=...)
//   GET  /api/newsletter/unsubscribe — leave the list (?email=...&token=...)

const INBOX = 'info@brimwoodinnovation.com';
const FROM = 'Brimwood Innovation <introductions@brimwoodinnovation.com>';
const SITE = 'https://brimwoodinnovation.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO_URL = 'https://brimwoodinnovation.com/logo-email.png';

// --- simple KV-backed rate limiting (abuse protection for the public forms) ---
async function checkRateLimit(env, key, limit, windowSecs) {
  const k = 'rl:' + key;
  const now = Date.now();
  let entry = null;
  try {
    const raw = await env.NEWSLETTER.get(k);
    if (raw) entry = JSON.parse(raw);
  } catch {
    entry = null; // corrupt entry: treat as fresh
  }
  if (!entry || now > entry.reset) entry = { count: 0, reset: now + windowSecs * 1000 };
  entry.count += 1;
  await env.NEWSLETTER.put(k, JSON.stringify(entry), { expirationTtl: windowSecs });
  return entry.count <= limit;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(title, preheader, bodyHtml) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title></head>' +
    '<body style="margin:0;padding:0;background-color:#F6F8F7;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(preheader) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F6F8F7;padding:32px 16px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">' +
    '<tr><td style="background-color:#0C9463;padding:28px 32px;">' +
    '<img src="' + LOGO_URL + '" width="200" alt="Brimwood Innovation" style="display:block;width:200px;max-width:60%;height:auto;border:0;">' +
    '<div style="font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#ffffff;margin-top:12px;">' + esc(title) + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding:32px;font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#121A16;font-size:15px;line-height:1.6;">' +
    bodyHtml +
    '</td></tr>' +
    '<tr><td style="background-color:#0A3D2B;padding:24px 32px;">' +
    '<div style="font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;">Build a business. Build yourself.</div>' +
    '<div style="font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#DDF5E9;margin-top:6px;">Brimwood Innovation &middot; 1365 Gerrard St E Unit 2, Toronto<br>brimwoodinnovation.com</div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>'
  );
}

function fieldRow(label, value) {
  return (
    '<tr><td style="padding:10px 0;border-bottom:1px solid #DDF5E9;">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#5B6862;">' + esc(label) + '</div>' +
    '<div style="font-size:15px;color:#121A16;margin-top:4px;white-space:pre-wrap;">' + esc(value || '—') + '</div>' +
    '</td></tr>'
  );
}

function button(url, label) {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background-color:#0C9463;border-radius:8px;">' +
    '<a href="' + esc(url) + '" style="display:inline-block;padding:14px 28px;font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">' + esc(label) + '</a>' +
    '</td></tr></table>'
  );
}

// Simple branded page served by the Worker (verify / unsubscribe landings).
function page(title, heading, message) {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + ' — Brimwood Innovation</title></head>' +
    '<body style="margin:0;padding:48px 16px;background-color:#F6F8F7;font-family:\'Plus Jakarta Sans\',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">' +
    '<div style="background-color:#0C9463;padding:28px 32px;">' +
    '<img src="' + LOGO_URL + '" width="180" alt="Brimwood Innovation" style="display:block;width:180px;max-width:60%;height:auto;border:0;">' +
    '<div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:12px;">' + esc(heading) + '</div></div>' +
    '<div style="padding:32px;color:#121A16;font-size:15px;line-height:1.6;">' + message + '</div>' +
    '<div style="background-color:#0A3D2B;padding:24px 32px;color:#DDF5E9;font-size:12px;">Build a business. Build yourself.<br>brimwoodinnovation.com</div>' +
    '</div></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function sendEmail(env, { to, subject, html, text, replyTo, headers }) {
  const payload = { from: FROM, to: [to], subject, html, text };
  if (replyTo) payload.reply_to = replyTo;
  if (headers) payload.headers = headers;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.RESEND_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error('Resend ' + r.status + ' ' + detail.slice(0, 300));
  }
  return r.json().catch(() => ({}));
}

async function handleIntroduction(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!(await checkRateLimit(env, 'intro:' + clientIp(request), 5, 3600))) {
    return Response.json(
      { ok: false, error: 'Too many requests. Please try again later.' },
      { status: 429 }
    );
  }
  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (String(data.website || '').trim()) {
    return Response.json({ ok: true }); // honeypot: bot — pretend success
  }
  const name = String(data.name || '').trim().slice(0, 100);
  const email = String(data.email || '').trim().slice(0, 200);
  const referral = String(data.referral || '').trim().slice(0, 200);
  const message = String(data.message || '').trim().slice(0, 2000);
  if (!name || !EMAIL_RE.test(email)) {
    return Response.json(
      { ok: false, error: 'Please include your name and a valid email address.' },
      { status: 400 }
    );
  }

  const notifyHtml = shell(
    'New introduction request',
    'Someone requested an introduction on brimwoodinnovation.com.',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      fieldRow('Name', name) +
      fieldRow('Email', email) +
      fieldRow('Referred by', referral) +
      fieldRow('What they are building', message) +
      '</table>' +
      '<p style="font-size:13px;color:#5B6862;margin:24px 0 0;">Reply directly to this email to reach ' + esc(name) + '.</p>'
  );
  const confirmHtml = shell(
    'Request received',
    'Thank you — your introduction request is on its way.',
    '<p style="margin:0 0 16px;">Hello ' + esc(name) + ',</p>' +
      '<p style="margin:0 0 16px;">Thank you. Your introduction request is on its way &mdash; we read every one personally and will be in touch.</p>' +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Membership is by invitation. Elite by effort, not by background.</p>'
  );

  await sendEmail(env, {
    to: INBOX,
    subject: 'New introduction request — ' + name,
    html: notifyHtml,
    text: 'New introduction request — brimwoodinnovation.com\n\nName: ' + name +
      '\nEmail: ' + email + '\nReferred by: ' + (referral || '—') +
      '\n\nWhat they are building:\n' + (message || '—'),
    replyTo: email,
  });
  await sendEmail(env, {
    to: email,
    subject: 'Thank you — Brimwood Innovation',
    html: confirmHtml,
    text: 'Hello ' + name + ',\n\nThank you. Your introduction request is on its way — we read every one personally and will be in touch.\n\nBuild a business. Build yourself.\n— Brimwood Innovation',
  });
  return Response.json({ ok: true });
}

async function handleNewsletterSubscribe(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!(await checkRateLimit(env, 'news:' + clientIp(request), 3, 3600))) {
    return Response.json(
      { ok: false, error: 'Too many requests. Please try again later.' },
      { status: 429 }
    );
  }
  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (String(data.website || '').trim()) {
    return Response.json({ ok: true }); // honeypot
  }
  const email = String(data.email || '').trim().toLowerCase().slice(0, 200);
  const name = String(data.name || '').trim().slice(0, 100);
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: 'Please enter a valid email address.' }, { status: 400 });
  }
  // Already subscribed? Treat as success, resend nothing.
  if (await env.NEWSLETTER.get('sub:' + email)) {
    return Response.json({ ok: true });
  }
  const token = crypto.randomUUID();
  await env.NEWSLETTER.put(
    'pending:' + token,
    JSON.stringify({ email, name, created: Date.now() }),
    { expirationTtl: 3 * 86400 }
  );
  const verifyUrl = SITE + '/api/newsletter/verify?token=' + encodeURIComponent(token);
  const html = shell(
    'Confirm your subscription',
    'One more step to join the Brimwood list.',
    '<p style="margin:0 0 16px;">Hello' + (name ? ' ' + esc(name) : '') + ',</p>' +
      '<p style="margin:0 0 8px;">You asked to join the Brimwood Innovation list. Please confirm your email address:</p>' +
      button(verifyUrl, 'Confirm my email') +
      '<p style="font-size:13px;color:#5B6862;margin:16px 0 0;">If you did not request this, just ignore this email — nothing will happen.</p>'
  );
  await sendEmail(env, {
    to: email,
    subject: 'Confirm your subscription — Brimwood Innovation',
    html,
    text: 'Hello' + (name ? ' ' + name : '') + ',\n\nYou asked to join the Brimwood Innovation list. Confirm your email address:\n' + verifyUrl + '\n\nIf you did not request this, just ignore this email.',
  });
  return Response.json({ ok: true });
}

async function handleNewsletterVerify(url, env) {
  const token = url.searchParams.get('token') || '';
  const raw = token ? await env.NEWSLETTER.get('pending:' + token) : null;
  if (!raw) {
    return page('Link expired', 'This link has expired', '<p style="margin:0;">That confirmation link is no longer valid. Please sign up again on <a href="' + SITE + '" style="color:#0C9463;">brimwoodinnovation.com</a>.</p>');
  }
  const { email, name } = JSON.parse(raw);
  const unsubToken = crypto.randomUUID();
  await env.NEWSLETTER.put(
    'sub:' + email,
    JSON.stringify({ email, name, unsubToken, subscribedAt: Date.now() })
  );
  await env.NEWSLETTER.delete('pending:' + token);

  const unsubUrl = SITE + '/api/newsletter/unsubscribe?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(unsubToken);
  const html = shell(
    "You're on the list",
    'Welcome to Brimwood Innovation.',
    '<p style="margin:0 0 16px;">Hello' + (name ? ' ' + esc(name) : '') + ',</p>' +
      '<p style="margin:0 0 16px;">You are on the list. We will write when there is something worth your time — no noise.</p>' +
      '<p style="margin:0;font-size:13px;color:#5B6862;">Build a business. Build yourself.</p>' +
      '<p style="font-size:12px;color:#5B6862;margin:24px 0 0;"><a href="' + esc(unsubUrl) + '" style="color:#5B6862;">Unsubscribe</a></p>'
  );
  await sendEmail(env, {
    to: email,
    subject: "You're on the list — Brimwood Innovation",
    html,
    text: "Hello" + (name ? ' ' + name : '') + ",\n\nYou are on the list. We will write when there is something worth your time — no noise.\n\nBuild a business. Build yourself.\n— Brimwood Innovation\n\nUnsubscribe: " + unsubUrl,
    headers: { 'List-Unsubscribe': '<' + unsubUrl + '>' },
  });
  await sendEmail(env, {
    to: INBOX,
    subject: 'New newsletter subscriber — Brimwood Innovation',
    html: shell(
      'New newsletter subscriber',
      'Someone joined the Brimwood list.',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        fieldRow('Email', email) +
        fieldRow('Name', name) +
        '</table>'
    ),
    text: 'New newsletter subscriber — brimwoodinnovation.com\n\nEmail: ' + email + '\nName: ' + (name || '—'),
  });
  return page("You're on the list", "You're on the list", '<p style="margin:0;">Welcome aboard' + (name ? ', ' + esc(name) : '') + '. We will write when there is something worth your time.</p>');
}

async function handleNewsletterUnsubscribe(url, env) {
  const email = (url.searchParams.get('email') || '').toLowerCase();
  const token = url.searchParams.get('token') || '';
  const raw = email ? await env.NEWSLETTER.get('sub:' + email) : null;
  if (raw && JSON.parse(raw).unsubToken === token && token) {
    await env.NEWSLETTER.delete('sub:' + email);
    return page('Unsubscribed', 'Unsubscribed', '<p style="margin:0;">You have been removed from the list. No hard feelings.</p>');
  }
  return page('Link invalid', 'This link is not valid', '<p style="margin:0;">That unsubscribe link did not match our records.</p>');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.RESEND_API_KEY) {
      return Response.json({ ok: false }, { status: 500 });
    }
    try {
      if (url.pathname === '/api/introduction') {
        return await handleIntroduction(request, env);
      }
      if (url.pathname === '/api/newsletter') {
        return await handleNewsletterSubscribe(request, env);
      }
      if (url.pathname === '/api/newsletter/verify') {
        return await handleNewsletterVerify(url, env);
      }
      if (url.pathname === '/api/newsletter/unsubscribe') {
        return await handleNewsletterUnsubscribe(url, env);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('email hub error:', String((e && e.message) || e));
      return Response.json({ ok: false }, { status: 502 });
    }
  },
};
