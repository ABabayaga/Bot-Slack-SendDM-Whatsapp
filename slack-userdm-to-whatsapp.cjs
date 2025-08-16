'use strict';
require('dotenv').config({ override: true });

const { WebClient } = require('@slack/web-api');

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DEST_NUMBERS = (process.env.DEST_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'hello_world';
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'en_US';

const SLACK_USER_TOKEN = (process.env.SLACK_USER_TOKEN || '').trim();
const FORWARD_OUTGOING = String(process.env.FORWARD_OUTGOING || 'false').toLowerCase() === 'true';

const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 120000);             // 2min padrão
const COOLDOWN_SUMMARY = String(process.env.COOLDOWN_SUMMARY || 'true').toLowerCase() === 'true';

if (!TOKEN || !PHONE_NUMBER_ID || DEST_NUMBERS.length === 0) {
  console.error('Faltam variáveis .env do WhatsApp: WHATSAPP_TOKEN, PHONE_NUMBER_ID e/ou DEST_NUMBERS');
  process.exit(1);
}
if (!/^xoxp-/.test(SLACK_USER_TOKEN)) {
  console.error('Falta SLACK_USER_TOKEN (User Token, começa com xoxp-)');
  process.exit(1);
}

const slack = new WebClient(SLACK_USER_TOKEN);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ===== WhatsApp helpers =====
async function waSendText(to, body) {
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`wa text failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function waUploadMedia(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  if (mime) form.append('type', mime);
  form.append('file', blob, filename);
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`wa upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.id;
}
async function waSendImage(to, mediaId, caption) {
  const payload = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`wa image failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function waSendDoc(to, mediaId, filename, caption) {
  const payload = { messaging_product: 'whatsapp', to, type: 'document',
    document: { id: mediaId, filename, caption } };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`wa doc failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function waSendTemplate(to) {
  const payload = { messaging_product: 'whatsapp', to, type: 'template',
    template: { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANG } } };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`wa template failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function waSafeText(to, body) {
  try { return await waSendText(to, body); }
  catch (err) {
    const s = String(err.message || '');
    if (s.includes('131051') || s.includes('24')) {
      await waSendTemplate(to);
      await sleep(1200);
      return await waSendText(to, body);
    }
    throw err;
  }
}
async function waSafeMedia(to, header, bytes, filename, mime) {
  const mediaId = await waUploadMedia(bytes, filename, mime);
  const caption = header.slice(0, 900);
  try {
    if ((mime || '').startsWith('image/')) return await waSendImage(to, mediaId, caption);
    return await waSendDoc(to, mediaId, filename, caption);
  } catch (err) {
    const s = String(err.message || '');
    if (s.includes('131051') || s.includes('24')) {
      await waSendTemplate(to);
      await sleep(1200);
      if ((mime || '').startsWith('image/')) return await waSendImage(to, mediaId, caption);
      return await waSendDoc(to, mediaId, filename, caption);
    }
    throw err;
  }
}

// ===== Slack polling (User Token) =====
const lastTsByChannel = new Map();      // channel -> last_ts encaminhado
const seen = new Set();                 // de-dup (channel:ts)
const userCache = new Map();
let selfUserId = null;

// ===== Cooldown por conversa =====
const lastNotifyAtByChannel = new Map(); // channel -> timestamp (ms) do último envio ao WA
const suppressedByChannel = new Map();   // channel -> {count, files, firstTs, lastTs, lastSender, lastPreview}

function withinCooldown(channel) {
  const last = lastNotifyAtByChannel.get(channel) || 0;
  return (Date.now() - last) < COOLDOWN_MS;
}
function recordSuppressed(channel, sender, preview, ts, filesCount = 0) {
  const entry = suppressedByChannel.get(channel) || {
    count: 0, files: 0, firstTs: ts, lastTs: ts, lastSender: sender, lastPreview: preview || ''
  };
  entry.count += 1;
  entry.files += (filesCount || 0);
  entry.lastTs = ts;
  if (preview) entry.lastPreview = preview;
  entry.lastSender = sender || entry.lastSender;
  suppressedByChannel.set(channel, entry);
}
function tsToLocale(ts) {
  const ms = Math.round(parseFloat(String(ts)) * 1000);
  return new Date(ms).toLocaleString('pt-BR');
}
async function maybeSendCooldownSummary(channel) {
  if (!COOLDOWN_SUMMARY) return;
  const entry = suppressedByChannel.get(channel);
  if (!entry) return;
  const last = lastNotifyAtByChannel.get(channel) || 0;
  if ((Date.now() - last) < COOLDOWN_MS) return;

  const from = tsToLocale(entry.firstTs);
  const to = tsToLocale(entry.lastTs);
  const filesChunk = entry.files ? `, ${entry.files} anexo(s)` : '';
  const lastLine = entry.lastPreview ? `\nÚltima: ${entry.lastSender}: ${entry.lastPreview.slice(0, 300)}` : '';
  const body = `🔔 Resumo Slack: ${entry.count} nova(s) mensagem(ns)${filesChunk} entre ${from} e ${to}.${lastLine}`.slice(0, 1000);

  let anySuccess = false;
  for (const toNum of DEST_NUMBERS) {
    try { await waSafeText(toNum, body); anySuccess = true; }
    catch (e) { console.error(`WA resumo falhou (${toNum}):`, e.message); }
  }
  if (anySuccess) {
    lastNotifyAtByChannel.set(channel, Date.now());
    suppressedByChannel.delete(channel);
  }
}

// util: nome do usuário
async function getUserName(userId) {
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const u = await slack.users.info({ user: userId });
    const name = u.user?.profile?.real_name_normalized || u.user?.real_name || u.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// carrega canais IM/MPIM e seta baseline
async function bootstrap() {
  const auth = await slack.auth.test();
  selfUserId = auth.user_id;

  // lista DMs e DMs em grupo
  const channels = [];
  let cursor;
  do {
    const resp = await slack.conversations.list({
      types: 'im,mpim',
      limit: 1000,
      cursor
    });
    channels.push(...(resp.channels || []));
    cursor = resp.response_metadata?.next_cursor;
  } while (cursor);

  // baseline: pega último ts de cada canal para começar “daqui pra frente”
  for (const c of channels) {
    const h = await slack.conversations.history({ channel: c.id, limit: 1 });
    const latest = h.messages?.[0]?.ts || String(Date.now() / 1000);
    lastTsByChannel.set(c.id, latest);
    // inicia janela de cooldown “vencida” para permitir o 1º envio
    lastNotifyAtByChannel.set(c.id, 0);
  }

  console.log(`🔗 Monitorando ${channels.length} DM(s). FORWARD_OUTGOING=${FORWARD_OUTGOING}`);
}

// varre novos eventos
async function pollOnce() {
  for (const [channel, lastTs] of lastTsByChannel.entries()) {
    try {
      const resp = await slack.conversations.history({
        channel,
        oldest: lastTs,
        inclusive: false,
        limit: 200
      });

      // ordena do mais antigo para o mais novo
      const msgs = (resp.messages || []).slice().sort((a,b) => Number(a.ts) - Number(b.ts));
      let newLast = lastTs;

      for (const m of msgs) {
        const key = `${channel}:${m.ts}`;
        if (seen.has(key)) { newLast = m.ts; continue; }
        seen.add(key);

        // ignora mensagens de sistema/edições/deleções
        const subtype = m.subtype || '';
        if (['message_deleted','message_changed','channel_join','channel_leave','channel_topic','channel_purpose','channel_name','bot_message'].includes(subtype)) {
          newLast = m.ts;
          continue;
        }

        const isFromMe = (m.user && m.user === selfUserId);
        if (!FORWARD_OUTGOING && isFromMe) { newLast = m.ts; continue; }

        const sender = m.user ? await getUserName(m.user) : 'alguém';
        const when = tsToLocale(m.ts);
        const header = `💬 Slack DM de ${sender} — ${when}`;
        const preview = (m.text || '').trim();

        // ===== COOLDOWN CHECK =====
        const inCooldown = withinCooldown(channel);

        // 1) texto
        if (preview) {
          if (inCooldown) {
            recordSuppressed(channel, sender, preview, m.ts, 0);
          } else {
            let anySuccess = false;
            const body = `${header}\n\n${preview}`.slice(0, 1000);
            for (const to of DEST_NUMBERS) {
              try { await waSafeText(to, body); anySuccess = true; }
              catch (e) { console.error(`WA texto falhou (${to}):`, e.message); }
            }
            if (anySuccess) lastNotifyAtByChannel.set(channel, Date.now());
          }
        }

        // 2) anexos
        if (Array.isArray(m.files) && m.files.length) {
          if (inCooldown) {
            recordSuppressed(channel, sender, preview, m.ts, m.files.length);
          } else {
            // Aviso: se quiser que após enviar 1 texto, os anexos sejam “mutados”, o cooldown acima já vai bloquear
            for (const f of m.files) {
              try {
                const url = f.url_private_download || f.url_private || f.permalink;
                if (!url) continue;
                const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` } });
                if (!res.ok) throw new Error(`download ${res.status}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const mime = f.mimetype || 'application/octet-stream';
                const filename = f.name || `slack-file-${f.id}`;
                const cap = `${header}\n\n${preview || ''}`.trim().slice(0, 900);

                let anySuccess = false;
                for (const to of DEST_NUMBERS) {
                  try { await waSafeMedia(to, cap, bytes, filename, mime); anySuccess = true; }
                  catch (e) { console.error(`WA anexo falhou (${to}:${filename}):`, e.message); }
                }
                if (anySuccess) lastNotifyAtByChannel.set(channel, Date.now());
              } catch (e) {
                console.warn('Falha baixando anexo:', e.message);
              }
              // após primeiro envio, novas mensagens entrarão no cooldown automaticamente
            }
          }
        }

        newLast = m.ts;
      }

      // Ao final do canal, se há mensagens suprimidas e cooldown venceu, manda resumo
      await maybeSendCooldownSummary(channel);

      if (newLast !== lastTs) lastTsByChannel.set(channel, newLast);
    } catch (e) {
      console.error('poll error:', e.message);
    }
  }
}

(async () => {
  await bootstrap();
  console.log('⚡️ Espelhando DMs pessoais (User Token) com cooldown por conversa.');
  while (true) {
    await pollOnce();
    await sleep(5000); // ajuste o intervalo (ms) geral de varredura
  }
})();
