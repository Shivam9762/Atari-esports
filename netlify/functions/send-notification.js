'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');

const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || 'atariesports@proton.me')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
);
const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin'
};
const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  body: JSON.stringify(body)
});

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON'); }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
  });
}

async function authenticate(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = await getAdminApp() && await admin.auth().verifyIdToken(match[1], true);
    if (!decoded || !decoded.uid) return null;
    const user = await admin.auth().getUser(decoded.uid);
    return {
      uid: decoded.uid,
      email: String(user.email || decoded.email || '').trim().toLowerCase(),
      admin: ADMIN_EMAILS.has(String(user.email || decoded.email || '').trim().toLowerCase())
    };
  } catch (_) { return null; }
}

async function rateLimit(uid, bucket, limit, windowMs) {
  const db = admin.firestore();
  const ref = db.collection('_pushRateLimits').doc(`${uid}_${bucket}`);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = snap.exists && Array.isArray(snap.data().times) ? snap.data().times : [];
    const recent = old.filter(t => Number.isFinite(t) && now - t < windowMs);
    if (recent.length >= limit) throw Object.assign(new Error('rate-limited'), { code: 'RATE_LIMITED' });
    recent.push(now);
    tx.set(ref, { times: recent, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}
function normalizeTargets(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  if (!list.length || list.length > 200) return [];
  const out = [...new Set(list.map(v => String(v || '').trim().toLowerCase()).filter(v => v && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))];
  return out;
}

async function sendOneSignal({ title, message, targets, broadcast }) {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) throw new Error('OneSignal environment is not configured');
  const auth = apiKey.startsWith('os_v2_') ? `Key ${apiKey}` : `Basic ${apiKey}`;
  const base = { app_id: appId, headings: { en: title }, contents: { en: message } };
  let payload;
  if (broadcast) {
    const segments = process.env.ONESIGNAL_SEGMENT ? [process.env.ONESIGNAL_SEGMENT] : ['All', 'Total Subscriptions', 'Subscribed Users'];
    let lastError;
    for (const segment of segments) {
      const r = await fetch('https://api.onesignal.com/notifications?c=push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ ...base, included_segments: [segment] })
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return { id: data.id || null, recipients: Number(data.recipients) || 0 };
      lastError = new Error('OneSignal rejected the notification'); lastError.providerStatus = r.status;
      if (process.env.ONESIGNAL_SEGMENT || !/segment/i.test(JSON.stringify(data))) break;
    }
    throw lastError || new Error('OneSignal rejected the notification');
  }
  if (!targets || !targets.length) throw new Error('No recipients');
  payload = process.env.ONESIGNAL_TARGET_MODE === 'aliases'
    ? { ...base, include_aliases: { external_id: targets }, target_channel: 'push' }
    : { ...base, include_external_user_ids: targets, channel_for_external_user_ids: 'push' };
  const r = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error('OneSignal rejected the notification'); err.providerStatus = r.status; throw err; }
  return { id: data.id || null, recipients: Number(data.recipients) || 0 };
}

async function getTournamentAndMatch(tournamentId, matchId) {
  if (!tournamentId || !matchId || String(tournamentId).length > 160 || String(matchId).length > 160) return null;
  const db = admin.firestore();
  const snap = await db.collection('tournaments').doc(String(tournamentId)).get();
  if (!snap.exists) return null;
  const tournament = snap.data() || {};
  const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const match = matches.find(m => m && String(m.id) === String(matchId));
  return match ? { tournament, match } : null;
}

async function acceptedRecipients(tournament, match) {
  const db = admin.firestore();
  const regs = Array.isArray(tournament.registrations) ? tournament.registrations : [];
  let accepted = regs.filter(r => r && r.status === 'ACCEPTED' && r.playerOwner);
  const teamIds = Array.isArray(match.teamIds) ? new Set(match.teamIds.map(String)) : new Set();
  if (teamIds.size) accepted = accepted.filter(r => teamIds.has(String(r.id)) || teamIds.has(String(r.registrationId)));
  else if (String(match.group || '').trim()) accepted = accepted.filter(r => String(r.group || '').trim().toLowerCase() === String(match.group).trim().toLowerCase());
  const uids = [...new Set(accepted.map(r => String(r.playerOwner)).filter(Boolean))].slice(0, 200);
  const emails = [];
  for (const uid of uids) {
    try {
      const snap = await db.collection('users').doc(uid).get();
      const email = snap.exists ? String(snap.data().email || '').trim().toLowerCase() : '';
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emails.push(email);
    } catch (_) { /* skip invalid/missing recipient */ }
  }
  return [...new Set(emails)];
}

async function handleMatchUpdate(body, caller) {
  if (!caller.admin) return reply(403, { error: 'Admin access required' });
  const found = await getTournamentAndMatch(body.tournamentId, body.matchId);
  if (!found) return reply(404, { error: 'Tournament or match not found' });
  const { tournament, match } = found;
  const eventKind = body.eventKind === 'created' ? 'created' : 'room';
  const targets = await acceptedRecipients(tournament, match);
  if (!targets.length) return reply(200, { ok: true, sent: false, reason: 'No accepted recipients' });

  let title, message, fingerprint;
  if (eventKind === 'room') {
    // Credentials are read from Firestore, never trusted from the client request.
    if (match.roomPublished !== true || !String(match.roomId || '').trim()) {
      return reply(409, { error: 'Room credentials are not published in Firestore' });
    }
    title = `🎮 Room Details: ${cleanText(match.title || 'Match', 90)}`;
    message = `Room ID: ${cleanText(match.roomId, 100)}${match.roomPassword ? `, Password: ${cleanText(match.roomPassword, 100)}` : ''}. Join now!`;
    fingerprint = crypto.createHash('sha256').update(`${match.roomId}|${match.roomPassword || ''}`).digest('hex').slice(0, 20);
  } else {
    title = '📅 New match scheduled';
    message = `${cleanText(match.title || 'A match', 100)} was added to ${cleanText(tournament.name || 'your tournament', 100)}. Open the app for details.`;
    fingerprint = 'created';
  }

  const eventDocId = crypto.createHash('sha256').update(`${body.tournamentId}|${body.matchId}|${eventKind}|${fingerprint}`).digest('hex');
  const db = admin.firestore();
  const eventRef = db.collection('_pushEvents').doc(eventDocId);
  const eventSnap = await eventRef.get();
  if (eventSnap.exists) return reply(200, { ok: true, sent: false, duplicate: true });
  const result = await sendOneSignal({ title, message, targets, broadcast: false });
  await eventRef.set({ type: eventKind, tournamentId: String(body.tournamentId), matchId: String(body.matchId), sentAt: admin.firestore.FieldValue.serverTimestamp(), callerUid: caller.uid });
  return reply(200, { ok: true, sent: true, recipients: result.recipients });
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  let body;
  try {
    if (Buffer.byteLength(event.body || '', 'utf8') > 16_000) return reply(413, { error: 'Request too large' });
    body = JSON.parse(event.body || '{}');
  } catch (_) { return reply(400, { error: 'Invalid JSON' }); }

  try { getAdminApp(); }
  catch (_) { return reply(500, { error: 'Firebase Admin credentials are not configured' }); }
  const caller = await authenticate(event);
  if (!caller) return reply(401, { error: 'Sign in required' });
  try {
    const action = cleanText(body.action || 'send', 32);
    if (action === 'matchUpdate') {
      if (!caller.admin) return reply(403, { error: 'Admin access required' });
      await rateLimit(caller.uid, 'match', 20, 60_000);
      return await handleMatchUpdate(body, caller);
    }

    const title = cleanText(body.title, 120);
    const message = cleanText(body.message, 400);
    if (!title || !message) return reply(400, { error: 'Title and message are required' });
    const rawTarget = body.targetUserId;
    const targetFieldPresent = Object.prototype.hasOwnProperty.call(body, 'targetUserId');
    const targets = normalizeTargets(rawTarget);
    if (targetFieldPresent && rawTarget != null && !targets.length) return reply(400, { error: 'Invalid or empty target list' });
    if (targets.length && Array.isArray(rawTarget) && targets.length !== [...new Set(rawTarget.map(v => String(v || '').trim().toLowerCase()).filter(Boolean))].length) {
      return reply(400, { error: 'One or more recipients are invalid' });
    }

    if (targets.length) {
      const adminEmail = String(process.env.PRIMARY_ADMIN_EMAIL || 'atariesports@proton.me').trim().toLowerCase();
      if (!caller.admin && targets.some(t => t !== caller.email && t !== adminEmail)) return reply(403, { error: 'You may only notify your own account or the admin' });
      await rateLimit(caller.uid, 'targeted', caller.admin ? 30 : 8, 60_000);
      const result = await sendOneSignal({ title, message, targets, broadcast: false });
      return reply(200, { ok: true, sent: true, recipients: result.recipients });
    }

    if (body.broadcast !== true) return reply(400, { error: 'Explicit targetUserId or broadcast:true is required' });
    if (!caller.admin) return reply(403, { error: 'Admin access required for broadcast' });
    await rateLimit(caller.uid, 'broadcast', 3, 60 * 60_000);
    const result = await sendOneSignal({ title, message, targets: [], broadcast: true });
    return reply(200, { ok: true, sent: true, recipients: result.recipients });
  } catch (error) {
    if (error && error.code === 'RATE_LIMITED') return reply(429, { error: 'Too many notifications. Try again later.' });
    if (error && /FIREBASE_SERVICE_ACCOUNT_JSON/.test(error.message || '')) return reply(500, { error: 'Firebase Admin credentials are not configured correctly' });
    if (error && error.providerStatus) return reply(502, { error: 'Push provider temporarily rejected the request' });
    return reply(500, { error: 'Notification could not be sent' });
  }
};
