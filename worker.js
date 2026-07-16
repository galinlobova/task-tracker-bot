/**
 * Telegram Task Tracker Bot — Cloudflare Worker
 * Хранение: KV (binding TASKS). Секреты: BOT_TOKEN, SECRET.
 *
 * Возможности:
 *  - разделы задач (Раздел: текст задачи, /newsec, /secs, /mv)
 *  - дедлайны (/due N дата [время]) и их изменение той же командой
 *  - напоминания за 1 нед / 1 день / 1 час / 15 мин (кнопки, /remind N)
 *  - список с кнопками ✅ / 🗑 / ↩️ (/list)
 *  - рассылка всех задач каждый будний день в 8:00 МСК (cron)
 */

const REMINDER_OPTIONS = [
  { min: 10080, label: '1 неделю' },
  { min: 1440,  label: '1 день' },
  { min: 60,    label: '1 час' },
  { min: 15,    label: '15 минут' },
];
const MSK_MS = 3 * 60 * 60 * 1000; // UTC+3
const DEFAULT_SECTION = 'Общее';

export default {
  // ---------- Webhook от Telegram ----------
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.SECRET) return new Response('Forbidden', { status: 403 });

    let update;
    try { update = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
      } else if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        await registerChat(env, chatId);
        const reply = await handleCommand(env, chatId, update.message.text.trim());
        if (reply) await sendMessage(env, chatId, reply.text, reply.keyboard);
      }
    } catch (e) {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) await sendMessage(env, chatId, '⚠️ Ошибка: ' + e.message);
    }
    return new Response('OK');
  },

  // ---------- Cron: напоминания + утренняя рассылка ----------
  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    const chats = JSON.parse((await env.TASKS.get('chats')) || '[]');

    const msk = new Date(now + MSK_MS);
    const isDigestTime = msk.getUTCHours() === 8 && msk.getUTCMinutes() < 15;
    const isWeekday = msk.getUTCDay() >= 1 && msk.getUTCDay() <= 5;

    for (const chatId of chats) {
      const key = `tasks:${chatId}`;
      const tasks = JSON.parse((await env.TASKS.get(key)) || '[]');
      let changed = false;

      // Напоминания
      for (const t of tasks) {
        if (t.done || !t.deadline || !t.reminders?.length) continue;
        for (const offMin of t.reminders) {
          const fireAt = t.deadline - offMin * 60000;
          const already = (t.sent || []).includes(offMin);
          if (!already && now >= fireAt && now < t.deadline) {
            t.sent = t.sent || [];
            t.sent.push(offMin);
            changed = true;
            const opt = REMINDER_OPTIONS.find((o) => o.min === offMin);
            await sendMessage(env, chatId,
              `⏰ <b>Напоминание</b> (за ${opt ? opt.label : offMin + ' мин'})\n` +
              `${escapeHtml(t.text)}\n📅 Дедлайн: ${fmtDeadline(t.deadline)}`);
          }
        }
      }
      if (changed) await env.TASKS.put(key, JSON.stringify(tasks));

      // Утренний дайджест по будням в 8:00 МСК
      if (isDigestTime && isWeekday && tasks.some((t) => !t.done)) {
        const view = renderList(tasks, '🌅 <b>Задачи на сегодня</b>');
        await sendMessage(env, chatId, view.text, view.keyboard);
      }
    }
  },
};

async function registerChat(env, chatId) {
  const chats = JSON.parse((await env.TASKS.get('chats')) || '[]');
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    await env.TASKS.put('chats', JSON.stringify(chats));
  }
}

// ---------- Инлайн-кнопки ----------

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const key = `tasks:${chatId}`;
  const tasks = JSON.parse((await env.TASKS.get(key)) || '[]');
  const parts = cq.data.split(':');
  const action = parts[0];
  let notice = '';

  const byId = (id) => tasks.findIndex((t) => String(t.id) === id);

  if (['done', 'undo', 'del'].includes(action)) {
    const i = byId(parts[1]);
    if (i === -1) notice = 'Задача не найдена';
    else if (action === 'done') { tasks[i].done = true; notice = '✅ Выполнено'; }
    else if (action === 'undo') { tasks[i].done = false; notice = '↩️ В работе'; }
    else { tasks.splice(i, 1); notice = '🗑 Удалено'; }
    await env.TASKS.put(key, JSON.stringify(tasks));
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: notice });
    const view = renderList(tasks);
    await editMessage(env, chatId, messageId, view);
    return;
  }

  if (action === 'clear') {
    const remaining = tasks.filter((t) => !t.done);
    notice = `🧹 Удалено: ${tasks.length - remaining.length}`;
    await env.TASKS.put(key, JSON.stringify(remaining));
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: notice });
    await editMessage(env, chatId, messageId, renderList(remaining));
    return;
  }

  // Переключение напоминаний: rem:<id>:<min>, завершение: remok:<id>
  if (action === 'rem') {
    const i = byId(parts[1]);
    if (i !== -1) {
      const min = parseInt(parts[2], 10);
      const t = tasks[i];
      t.reminders = t.reminders || [];
      if (t.reminders.includes(min)) {
        t.reminders = t.reminders.filter((m) => m !== min);
        t.sent = (t.sent || []).filter((m) => m !== min);
      } else {
        t.reminders.push(min);
      }
      await env.TASKS.put(key, JSON.stringify(tasks));
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      await editMessage(env, chatId, messageId, reminderMenu(t));
    }
    return;
  }

  if (action === 'remok') {
    const i = byId(parts[1]);
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Сохранено' });
    if (i !== -1) {
      const t = tasks[i];
      const labels = REMINDER_OPTIONS.filter((o) => (t.reminders || []).includes(o.min)).map((o) => 'за ' + o.label);
      await editMessage(env, chatId, messageId, {
        text: `🔔 ${escapeHtml(t.text)}\n📅 ${fmtDeadline(t.deadline)}\nНапоминания: ${labels.length ? labels.join(', ') : 'нет'}`,
      });
    }
  }
}

// ---------- Текстовые команды ----------

async function handleCommand(env, chatId, text) {
  const key = `tasks:${chatId}`;
  const secKey = `sections:${chatId}`;
  const tasks = JSON.parse((await env.TASKS.get(key)) || '[]');
  const sections = JSON.parse((await env.TASKS.get(secKey)) || JSON.stringify([DEFAULT_SECTION]));
  const save = () => env.TASKS.put(key, JSON.stringify(tasks));
  const saveSec = () => env.TASKS.put(secKey, JSON.stringify(sections));

  if (text === '/start' || text === '/help') {
    return { text: [
      '📋 <b>Трекер задач</b>',
      '',
      '<b>Добавить задачу:</b> просто напиши текст.',
      'В раздел: <code>Работа: подготовить слайды</code>',
      '',
      '<b>Разделы:</b>',
      '/newsec Название — создать раздел',
      '/secs — список разделов',
      '/mv N Раздел — перенести задачу',
      '',
      '<b>Дедлайны и напоминания:</b>',
      '/due N 25.07 15:00 — задать/изменить срок',
      '  (можно: <code>/due 3 завтра</code>, <code>/due 3 сегодня 18:00</code>)',
      '/remind N — выбрать напоминания кнопками',
      '',
      '<b>Список:</b>',
      '/list — все задачи (кнопки: ✅ выполнить, 🗑 удалить)',
      '/done N, /undo N, /del N, /clear',
      '',
      '🌅 Каждый будний день в 8:00 МСК пришлю весь список,',
      '🔴 задачи с дедлайном сегодня будут выделены.',
    ].join('\n') };
  }

  if (text === '/list' || text === '/l') return renderList(tasks);

  if (text === '/secs') {
    return { text: '📂 Разделы:\n' + sections.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('\n') };
  }

  let m = text.match(/^\/newsec\s+(.+)$/);
  if (m) {
    const name = m[1].trim();
    if (sections.some((s) => s.toLowerCase() === name.toLowerCase())) return { text: 'Такой раздел уже есть.' };
    sections.push(name);
    await saveSec();
    return { text: `📂 Раздел «${escapeHtml(name)}» создан. Добавляй задачи так:\n<code>${escapeHtml(name)}: текст задачи</code>` };
  }

  m = text.match(/^\/mv\s+(\d+)\s+(.+)$/);
  if (m) {
    const t = tasks[parseInt(m[1], 10) - 1];
    if (!t) return { text: `Задачи №${m[1]} нет.` };
    const sec = sections.find((s) => s.toLowerCase() === m[2].trim().toLowerCase());
    if (!sec) return { text: `Раздела «${escapeHtml(m[2])}» нет. Создай: /newsec ${escapeHtml(m[2])}` };
    t.section = sec;
    await save();
    return renderList(tasks);
  }

  // /due N дата [время] — задать или изменить срок
  m = text.match(/^\/due\s+(\d+)\s+(.+)$/);
  if (m) {
    const t = tasks[parseInt(m[1], 10) - 1];
    if (!t) return { text: `Задачи №${m[1]} нет.` };
    const dl = parseDeadline(m[2].trim());
    if (!dl) return { text: 'Не поняла дату. Примеры:\n/due 3 25.07\n/due 3 25.07 15:00\n/due 3 завтра 18:00\n/due 3 сегодня' };
    t.deadline = dl;
    t.sent = []; // срок изменился — напоминания сработают заново
    await save();
    return reminderMenu(t, `📅 Срок задачи «${escapeHtml(t.text)}» — ${fmtDeadline(dl)}.\nЗа сколько напомнить?`);
  }

  m = text.match(/^\/remind\s+(\d+)$/);
  if (m) {
    const t = tasks[parseInt(m[1], 10) - 1];
    if (!t) return { text: `Задачи №${m[1]} нет.` };
    if (!t.deadline) return { text: 'Сначала задай срок: /due ' + m[1] + ' 25.07 15:00' };
    return reminderMenu(t);
  }

  m = text.match(/^\/(?:done|d)\s+(\d+)$/);
  if (m) { const t = tasks[parseInt(m[1],10)-1]; if (!t) return { text: `Задачи №${m[1]} нет.` }; t.done = true; await save(); return renderList(tasks); }
  m = text.match(/^\/undo\s+(\d+)$/);
  if (m) { const t = tasks[parseInt(m[1],10)-1]; if (!t) return { text: `Задачи №${m[1]} нет.` }; t.done = false; await save(); return renderList(tasks); }
  m = text.match(/^\/del\s+(\d+)$/);
  if (m) { const i = parseInt(m[1],10)-1; if (!tasks[i]) return { text: `Задачи №${m[1]} нет.` }; tasks.splice(i,1); await save(); return renderList(tasks); }
  if (text === '/clear') {
    const remaining = tasks.filter((t) => !t.done);
    tasks.length = 0; tasks.push(...remaining);
    await save();
    return renderList(tasks);
  }

  if (text.startsWith('/')) return { text: 'Не знаю такую команду. Напиши /help.' };

  // Добавление задачи, опционально с разделом: "Раздел: текст"
  let section = DEFAULT_SECTION;
  let taskText = text;
  const colon = text.indexOf(':');
  if (colon > 0) {
    const maybeSec = text.slice(0, colon).trim();
    const found = sections.find((s) => s.toLowerCase() === maybeSec.toLowerCase());
    if (found) { section = found; taskText = text.slice(colon + 1).trim(); }
  }
  if (!taskText) return { text: 'Пустая задача 🙂' };
  tasks.push({ id: Date.now(), text: taskText, done: false, section });
  await save();
  const n = tasks.length;
  return { text: `➕ Добавлено в «${escapeHtml(section)}» (№${n}): ${escapeHtml(taskText)}\nСрок: <code>/due ${n} 25.07 15:00</code>` };
}

// ---------- Меню выбора напоминаний ----------

function reminderMenu(t, header) {
  const chosen = t.reminders || [];
  const rows = REMINDER_OPTIONS.map((o) => [{
    text: `${chosen.includes(o.min) ? '☑️' : '⬜'} За ${o.label}`,
    callback_data: `rem:${t.id}:${o.min}`,
  }]);
  rows.push([{ text: '✔️ Готово', callback_data: `remok:${t.id}` }]);
  return {
    text: header || `🔔 ${escapeHtml(t.text)}\n📅 ${fmtDeadline(t.deadline)}\nЗа сколько напомнить? (можно несколько)`,
    keyboard: rows,
  };
}

// ---------- Отрисовка списка ----------

function renderList(tasks, title) {
  if (tasks.length === 0) return { text: '📭 Список пуст. Напиши текст задачи, чтобы добавить.' };

  const todayMsk = mskDateStr(Date.now());
  const groups = {};
  tasks.forEach((t, i) => {
    const sec = t.section || DEFAULT_SECTION;
    (groups[sec] = groups[sec] || []).push({ t, num: i + 1 });
  });

  const lines = [];
  for (const sec of Object.keys(groups)) {
    lines.push(`\n📂 <b>${escapeHtml(sec)}</b>`);
    for (const { t, num } of groups[sec]) {
      let dl = '';
      if (t.deadline) {
        const dStr = mskDateStr(t.deadline);
        if (!t.done && t.deadline < Date.now()) dl = ` ⚠️ <b>просрочено ${fmtDeadline(t.deadline)}</b>`;
        else if (!t.done && dStr === todayMsk) dl = ` 🔴 <b>сегодня ${fmtTime(t.deadline)}</b>`;
        else dl = ` 📅 ${fmtDeadline(t.deadline)}`;
      }
      lines.push(t.done
        ? `${num}. ✅ <s>${escapeHtml(t.text)}</s>`
        : `${num}. ⬜ ${escapeHtml(t.text)}${dl}`);
    }
  }
  const open = tasks.filter((t) => !t.done).length;

  const keyboard = tasks.map((t, i) => {
    const num = i + 1;
    const short = t.text.length > 18 ? t.text.slice(0, 18) + '…' : t.text;
    return [
      t.done
        ? { text: `↩️ ${num}. ${short}`, callback_data: `undo:${t.id}` }
        : { text: `✅ ${num}. ${short}`, callback_data: `done:${t.id}` },
      { text: '🗑', callback_data: `del:${t.id}` },
    ];
  });
  if (tasks.some((t) => t.done)) keyboard.push([{ text: '🧹 Убрать выполненные', callback_data: 'clear:0' }]);

  return { text: `${title || '📋 <b>Задачи</b>'} (в работе: ${open})` + lines.join('\n'), keyboard };
}

// ---------- Даты (МСК = UTC+3) ----------

function parseDeadline(str) {
  const m = str.toLowerCase().match(/^(сегодня|завтра|\d{1,2}\.\d{1,2}(?:\.\d{4})?)(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const nowMsk = new Date(Date.now() + MSK_MS);
  let y = nowMsk.getUTCFullYear(), mo = nowMsk.getUTCMonth(), d = nowMsk.getUTCDate();

  if (m[1] === 'завтра') d += 1;
  else if (m[1] !== 'сегодня') {
    const p = m[1].split('.');
    d = parseInt(p[0], 10);
    mo = parseInt(p[1], 10) - 1;
    if (p[2]) y = parseInt(p[2], 10);
    else if (mo < nowMsk.getUTCMonth() || (mo === nowMsk.getUTCMonth() && d < nowMsk.getUTCDate())) y += 1; // дата уже прошла — значит, следующий год
  }
  const hh = m[2] !== undefined ? parseInt(m[2], 10) : 10; // время по умолчанию 10:00 МСК
  const mm = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  if (hh > 23 || mm > 59) return null;
  return Date.UTC(y, mo, d, hh, mm) - MSK_MS;
}

function mskDateStr(ts) {
  const d = new Date(ts + MSK_MS);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
}
function fmtTime(ts) {
  const d = new Date(ts + MSK_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtDeadline(ts) {
  const d = new Date(ts + MSK_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${fmtTime(ts)}`;
}

// ---------- Утилиты ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function tg(env, method, body) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function sendMessage(env, chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await tg(env, 'sendMessage', body);
}
async function editMessage(env, chatId, messageId, view) {
  await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: view.text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: view.keyboard || [] },
  });
}
