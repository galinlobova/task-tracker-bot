/**
 * Telegram Task Tracker Bot — Cloudflare Worker
 * KV binding: TASKS. Секреты: BOT_TOKEN, SECRET.
 *
 *  - разделы; /list присылает отдельное сообщение на каждый раздел,
 *    кнопки задач — сразу под своим разделом
 *  - диалоговые команды: /newsec, /due, /mv, /remind, /done, /del, /undo
 *    без параметров дозапрашивают нужную информацию
 *  - дедлайны, напоминания (1 нед/1 день/1 час/15 мин)
 *  - рассылка по будням в 8:00 МСК (cron каждые 15 минут)
 */

const REMINDER_OPTIONS = [
  { min: 10080, label: '1 неделю' },
  { min: 1440,  label: '1 день' },
  { min: 60,    label: '1 час' },
  { min: 15,    label: '15 минут' },
];
const MSK_MS = 3 * 60 * 60 * 1000;
const DEFAULT_SECTION = 'Общее';
const DATE_HINT =
  'Формат даты: <code>ДД.ММ</code> или <code>ДД.ММ.ГГГГ</code>, время опционально.\n' +
  'Примеры:\n<code>25.07</code>\n<code>25.07 15:00</code>\n<code>сегодня 18:00</code>\n<code>завтра</code>';

export default {
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
        await handleMessage(env, chatId, update.message.text.trim());
      }
    } catch (e) {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) await sendMessage(env, chatId, '⚠️ Ошибка: ' + e.message);
    }
    return new Response('OK');
  },

  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    const chats = JSON.parse((await env.TASKS.get('chats')) || '[]');
    const msk = new Date(now + MSK_MS);
    const isDigestTime = msk.getUTCHours() === 8 && msk.getUTCMinutes() < 15;
    const isWeekday = msk.getUTCDay() >= 1 && msk.getUTCDay() <= 5;

    for (const chatId of chats) {
      const tasks = await getTasks(env, chatId);
      let changed = false;

      for (const t of tasks) {
        if (t.done || !t.deadline || !t.reminders?.length) continue;
        for (const offMin of t.reminders) {
          const fireAt = t.deadline - offMin * 60000;
          if (!(t.sent || []).includes(offMin) && now >= fireAt && now < t.deadline) {
            (t.sent = t.sent || []).push(offMin);
            changed = true;
            const opt = REMINDER_OPTIONS.find((o) => o.min === offMin);
            await sendMessage(env, chatId,
              `⏰ <b>Напоминание</b> (за ${opt ? opt.label : offMin + ' мин'})\n` +
              `${escapeHtml(t.text)}\n📅 Дедлайн: ${fmtDeadline(t.deadline)}`);
          }
        }
      }
      if (changed) await putTasks(env, chatId, tasks);

      if (isDigestTime && isWeekday && tasks.some((t) => !t.done)) {
        const sections = await getSections(env, chatId);
        await sendList(env, chatId, tasks, sections, '🌅 <b>Задачи на сегодня</b>');
      }
    }
  },
};

// ================= Хранилище =================

const getTasks = async (env, id) => JSON.parse((await env.TASKS.get(`tasks:${id}`)) || '[]');
const putTasks = (env, id, t) => env.TASKS.put(`tasks:${id}`, JSON.stringify(t));
const getSections = async (env, id) => JSON.parse((await env.TASKS.get(`sections:${id}`)) || JSON.stringify([DEFAULT_SECTION]));
const putSections = (env, id, s) => env.TASKS.put(`sections:${id}`, JSON.stringify(s));
const getPending = async (env, id) => JSON.parse((await env.TASKS.get(`pending:${id}`)) || 'null');
const setPending = (env, id, p) => env.TASKS.put(`pending:${id}`, JSON.stringify(p), { expirationTtl: 3600 });
const clearPending = (env, id) => env.TASKS.delete(`pending:${id}`);

async function registerChat(env, chatId) {
  const chats = JSON.parse((await env.TASKS.get('chats')) || '[]');
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    await env.TASKS.put('chats', JSON.stringify(chats));
  }
}

// ================= Сообщения =================

async function handleMessage(env, chatId, raw) {
  let text = raw;
  if (text.startsWith('/')) text = text.replace(/^(\/[a-zA-Z_]+)@\S+/, '$1');

  const tasks = await getTasks(env, chatId);
  const sections = await getSections(env, chatId);

  if (text.startsWith('/')) {
    await clearPending(env, chatId); // новая команда отменяет начатый диалог
    return handleSlash(env, chatId, text, tasks, sections);
  }

  const pending = await getPending(env, chatId);
  if (pending) return handlePendingInput(env, chatId, text, pending, tasks, sections);

  // Обычный текст — новая задача ("Раздел: текст" кладёт в раздел)
  let section = DEFAULT_SECTION;
  let taskText = text;
  const colon = text.indexOf(':');
  if (colon > 0) {
    const found = sections.find((s) => s.toLowerCase() === text.slice(0, colon).trim().toLowerCase());
    if (found) { section = found; taskText = text.slice(colon + 1).trim(); }
  }
  if (!taskText) return sendMessage(env, chatId, 'Пустая задача 🙂');
  tasks.push({ id: Date.now(), text: taskText, done: false, section });
  await putTasks(env, chatId, tasks);
  const n = tasks.length;
  await sendMessage(env, chatId,
    `➕ Добавлено в «${escapeHtml(section)}» (№${n}): ${escapeHtml(taskText)}\n` +
    `Задать срок: /due · Перенести в раздел: /mv`);
}

// ================= Команды =================

async function handleSlash(env, chatId, text, tasks, sections) {
  const taskByNum = (numStr) => tasks[parseInt(numStr, 10) - 1];

  if (text === '/start' || text === '/help') {
    return sendMessage(env, chatId, [
      '📋 <b>Трекер задач</b>',
      '',
      '<b>Добавить задачу:</b> просто напиши текст.',
      'Сразу в раздел: <code>Работа: подготовить слайды</code>',
      '',
      '<b>Команды</b> (можно без параметров — я всё спрошу):',
      '/list — список задач по разделам',
      '/newsec — создать раздел, /secs — все разделы',
      '/mv — перенести задачу в раздел',
      '/due — задать или изменить срок',
      '/remind — настроить напоминания (1 нед / 1 день / 1 час / 15 мин)',
      '/done, /undo, /del — выполнить / вернуть / удалить',
      '/clear — убрать все выполненные',
      '',
      '🌅 По будням в 8:00 МСК пришлю весь список,',
      '🔴 задачи с дедлайном сегодня будут выделены.',
    ].join('\n'));
  }

  if (text === '/list' || text === '/l') {
    return sendList(env, chatId, tasks, sections);
  }

  if (text === '/secs') {
    const counts = sections.map((s) => {
      const n = tasks.filter((t) => !t.done && (t.section || DEFAULT_SECTION) === s).length;
      return `📂 ${escapeHtml(s)} — в работе: ${n}`;
    });
    return sendMessage(env, chatId, '<b>Разделы:</b>\n' + counts.join('\n') + '\n\nНовый раздел: /newsec');
  }

  // ---- /newsec ----
  let m = text.match(/^\/newsec(?:\s+(.+))?$/);
  if (m) {
    if (!m[1]) {
      await setPending(env, chatId, { action: 'newsec' });
      return sendMessage(env, chatId, '📂 Введи название нового раздела:');
    }
    return createSection(env, chatId, m[1].trim(), sections);
  }

  // ---- /mv ----
  m = text.match(/^\/mv(?:\s+(\d+))?(?:\s+(.+))?$/);
  if (m) {
    if (!m[1]) {
      await setPending(env, chatId, { action: 'mv_num' });
      return sendMessage(env, chatId, '↔️ Какую задачу перенести? Напиши её номер (номера видны в /list):');
    }
    const t = taskByNum(m[1]);
    if (!t) return sendMessage(env, chatId, `Задачи №${m[1]} нет. Посмотри номера: /list`);
    if (!m[2]) return askSection(env, chatId, t, sections);
    const sec = sections.find((s) => s.toLowerCase() === m[2].trim().toLowerCase());
    if (!sec) return sendMessage(env, chatId, `Раздела «${escapeHtml(m[2])}» нет. Создай его: /newsec`);
    t.section = sec;
    await putTasks(env, chatId, tasks);
    return sendMessage(env, chatId, `↔️ «${escapeHtml(t.text)}» → 📂 ${escapeHtml(sec)}`);
  }

  // ---- /due ----
  m = text.match(/^\/due(?:\s+(\d+))?(?:\s+(.+))?$/);
  if (m) {
    if (!m[1]) {
      await setPending(env, chatId, { action: 'due_num' });
      return sendMessage(env, chatId, '📅 Какой задаче задать срок? Напиши её номер:');
    }
    const t = taskByNum(m[1]);
    if (!t) return sendMessage(env, chatId, `Задачи №${m[1]} нет. Посмотри номера: /list`);
    if (!m[2]) {
      await setPending(env, chatId, { action: 'due_date', taskId: t.id });
      return sendMessage(env, chatId, `📅 Когда дедлайн у «${escapeHtml(t.text)}»?\n\n${DATE_HINT}`);
    }
    return applyDeadline(env, chatId, tasks, t, m[2].trim());
  }

  // ---- /remind ----
  m = text.match(/^\/remind(?:\s+(\d+))?$/);
  if (m) {
    if (!m[1]) {
      await setPending(env, chatId, { action: 'remind_num' });
      return sendMessage(env, chatId, '🔔 Для какой задачи настроить напоминания? Напиши номер:');
    }
    const t = taskByNum(m[1]);
    if (!t) return sendMessage(env, chatId, `Задачи №${m[1]} нет.`);
    if (!t.deadline) {
      await setPending(env, chatId, { action: 'due_date', taskId: t.id });
      return sendMessage(env, chatId, `У задачи нет срока — сначала зададим его.\n📅 Когда дедлайн?\n\n${DATE_HINT}`);
    }
    const menu = reminderMenu(t);
    return sendMessage(env, chatId, menu.text, menu.keyboard);
  }

  // ---- /done /undo /del ----
  m = text.match(/^\/(done|d|undo|del)(?:\s+(\d+))?$/);
  if (m) {
    const action = m[1] === 'd' ? 'done' : m[1];
    if (!m[2]) {
      await setPending(env, chatId, { action: action + '_num' });
      const verbs = { done: 'отметить выполненной', undo: 'вернуть в работу', del: 'удалить' };
      return sendMessage(env, chatId, `Какую задачу ${verbs[action]}? Напиши номер:`);
    }
    return applySimple(env, chatId, tasks, action, m[2]);
  }

  if (text === '/clear') {
    const remaining = tasks.filter((t) => !t.done);
    const removed = tasks.length - remaining.length;
    await putTasks(env, chatId, remaining);
    return sendMessage(env, chatId, `🧹 Удалено выполненных: ${removed}. Актуальный список: /list`);
  }

  return sendMessage(env, chatId, 'Не знаю такую команду. Напиши /help.');
}

// ================= Диалоговые ответы =================

async function handlePendingInput(env, chatId, text, pending, tasks, sections) {
  const needNum = () => {
    const m = text.match(/^\d+$/);
    if (!m) { sendMessage(env, chatId, 'Напиши просто номер задачи, например: 2\n(номера видны в /list)'); return null; }
    const t = tasks[parseInt(text, 10) - 1];
    if (!t) { sendMessage(env, chatId, `Задачи №${text} нет. Посмотри номера: /list`); return null; }
    return t;
  };

  switch (pending.action) {
    case 'newsec':
      await clearPending(env, chatId);
      return createSection(env, chatId, text, sections);

    case 'mv_num': {
      const t = needNum(); if (!t) return;
      await clearPending(env, chatId);
      return askSection(env, chatId, t, sections);
    }

    case 'due_num': {
      const t = needNum(); if (!t) return;
      await setPending(env, chatId, { action: 'due_date', taskId: t.id });
      return sendMessage(env, chatId, `📅 Когда дедлайн у «${escapeHtml(t.text)}»?\n\n${DATE_HINT}`);
    }

    case 'due_date': {
      const t = tasks.find((x) => x.id === pending.taskId);
      if (!t) { await clearPending(env, chatId); return sendMessage(env, chatId, 'Задача не найдена — возможно, удалена.'); }
      const dl = parseDeadline(text);
      if (!dl) {
        // остаёмся в диалоге и подсказываем формат
        return sendMessage(env, chatId, `Не поняла дату 🤔\n\n${DATE_HINT}\n\nПопробуй ещё раз:`);
      }
      await clearPending(env, chatId);
      return applyDeadline(env, chatId, tasks, t, text, dl);
    }

    case 'remind_num': {
      const t = needNum(); if (!t) return;
      await clearPending(env, chatId);
      if (!t.deadline) {
        await setPending(env, chatId, { action: 'due_date', taskId: t.id });
        return sendMessage(env, chatId, `У задачи нет срока — сначала зададим его.\n📅 Когда дедлайн?\n\n${DATE_HINT}`);
      }
      const menu = reminderMenu(t);
      return sendMessage(env, chatId, menu.text, menu.keyboard);
    }

    case 'done_num': case 'undo_num': case 'del_num': {
      const t = needNum(); if (!t) return;
      await clearPending(env, chatId);
      return applySimple(env, chatId, tasks, pending.action.replace('_num', ''), text);
    }
  }
  await clearPending(env, chatId);
}

// ================= Действия =================

async function createSection(env, chatId, name, sections) {
  name = name.replace(/:/g, '').trim();
  if (!name) return sendMessage(env, chatId, 'Название не может быть пустым. Попробуй ещё раз: /newsec');
  if (sections.some((s) => s.toLowerCase() === name.toLowerCase())) {
    return sendMessage(env, chatId, `Раздел «${escapeHtml(name)}» уже есть.`);
  }
  sections.push(name);
  await putSections(env, chatId, sections);
  return sendMessage(env, chatId,
    `📂 Раздел «${escapeHtml(name)}» создан.\nДобавляй в него задачи так:\n<code>${escapeHtml(name)}: текст задачи</code>`);
}

function askSection(env, chatId, task, sections) {
  const rows = sections.map((s, i) => [{ text: '📂 ' + s, callback_data: `mvsec:${task.id}:${i}` }]);
  return sendMessage(env, chatId, `↔️ В какой раздел перенести «${escapeHtml(task.text)}»?`, rows);
}

async function applyDeadline(env, chatId, tasks, t, dateStr, parsed) {
  const dl = parsed !== undefined ? parsed : parseDeadline(dateStr);
  if (!dl) return sendMessage(env, chatId, `Не поняла дату 🤔\n\n${DATE_HINT}\n\nПовтори команду: /due`);
  t.deadline = dl;
  t.sent = [];
  await putTasks(env, chatId, tasks);
  const menu = reminderMenu(t, `📅 Срок «${escapeHtml(t.text)}» — <b>${fmtDeadline(dl)}</b>.\nЗа сколько напомнить? (можно несколько)`);
  return sendMessage(env, chatId, menu.text, menu.keyboard);
}

async function applySimple(env, chatId, tasks, action, numStr) {
  const i = parseInt(numStr, 10) - 1;
  const t = tasks[i];
  if (!t) return sendMessage(env, chatId, `Задачи №${numStr} нет. Посмотри номера: /list`);
  if (action === 'done') { t.done = true; await putTasks(env, chatId, tasks); return sendMessage(env, chatId, `✅ Выполнено: ${escapeHtml(t.text)}`); }
  if (action === 'undo') { t.done = false; await putTasks(env, chatId, tasks); return sendMessage(env, chatId, `↩️ В работе: ${escapeHtml(t.text)}`); }
  tasks.splice(i, 1);
  await putTasks(env, chatId, tasks);
  return sendMessage(env, chatId, `🗑 Удалено: ${escapeHtml(t.text)}`);
}

// ================= Инлайн-кнопки =================

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const tasks = await getTasks(env, chatId);
  const sections = await getSections(env, chatId);
  const parts = cq.data.split(':');
  const action = parts[0];
  const byId = (id) => tasks.findIndex((t) => String(t.id) === id);
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });

  if (['done', 'undo', 'del'].includes(action)) {
    const i = byId(parts[1]);
    if (i === -1) return ack('Задача не найдена — обнови /list');
    const section = tasks[i].section || DEFAULT_SECTION;
    let notice;
    if (action === 'done') { tasks[i].done = true; notice = '✅ Выполнено'; }
    else if (action === 'undo') { tasks[i].done = false; notice = '↩️ В работе'; }
    else { tasks.splice(i, 1); notice = '🗑 Удалено'; }
    await putTasks(env, chatId, tasks);
    await ack(notice);
    const view = renderSection(tasks, section);
    return editMessage(env, chatId, messageId,
      view || { text: `📂 <b>${escapeHtml(section)}</b>\n— пусто` });
  }

  if (action === 'mvsec') {
    const i = byId(parts[1]);
    if (i === -1) return ack('Задача не найдена');
    const sec = sections[parseInt(parts[2], 10)];
    if (!sec) return ack('Раздел не найден');
    tasks[i].section = sec;
    await putTasks(env, chatId, tasks);
    await ack('Перенесено');
    return editMessage(env, chatId, messageId,
      { text: `↔️ «${escapeHtml(tasks[i].text)}» → 📂 <b>${escapeHtml(sec)}</b>` });
  }

  if (action === 'rem') {
    const i = byId(parts[1]);
    if (i === -1) return ack('Задача не найдена');
    const min = parseInt(parts[2], 10);
    const t = tasks[i];
    t.reminders = t.reminders || [];
    if (t.reminders.includes(min)) {
      t.reminders = t.reminders.filter((x) => x !== min);
      t.sent = (t.sent || []).filter((x) => x !== min);
    } else t.reminders.push(min);
    await putTasks(env, chatId, tasks);
    await ack('');
    return editMessage(env, chatId, messageId, reminderMenu(t));
  }

  if (action === 'remok') {
    const i = byId(parts[1]);
    await ack('Сохранено');
    if (i === -1) return;
    const t = tasks[i];
    const labels = REMINDER_OPTIONS.filter((o) => (t.reminders || []).includes(o.min)).map((o) => 'за ' + o.label);
    return editMessage(env, chatId, messageId, {
      text: `🔔 ${escapeHtml(t.text)}\n📅 ${fmtDeadline(t.deadline)}\nНапоминания: ${labels.length ? labels.join(', ') : 'нет'}`,
    });
  }
}

// ================= Отрисовка =================

function renderSection(tasks, section) {
  const items = [];
  tasks.forEach((t, i) => {
    if ((t.section || DEFAULT_SECTION) === section) items.push({ t, num: i + 1 });
  });
  if (!items.length) return null;

  const todayMsk = mskDateStr(Date.now());
  const lines = items.map(({ t, num }) => {
    let dl = '';
    if (t.deadline && !t.done) {
      if (t.deadline < Date.now()) dl = `\n    ⚠️ <b>просрочено ${fmtDeadline(t.deadline)}</b>`;
      else if (mskDateStr(t.deadline) === todayMsk) dl = `\n    🔴 <b>сегодня ${fmtTime(t.deadline)}</b>`;
      else dl = `\n    📅 ${fmtDeadline(t.deadline)}`;
    }
    return t.done
      ? `${num}. ✅ <s>${escapeHtml(t.text)}</s>`
      : `${num}. ⬜ ${escapeHtml(t.text)}${dl}`;
  });

  const keyboard = items.map(({ t, num }) => {
    const short = t.text.length > 18 ? t.text.slice(0, 18) + '…' : t.text;
    return [
      t.done
        ? { text: `↩️ ${num}. ${short}`, callback_data: `undo:${t.id}` }
        : { text: `✅ ${num}. ${short}`, callback_data: `done:${t.id}` },
      { text: '🗑', callback_data: `del:${t.id}` },
    ];
  });

  return { text: `📂 <b>${escapeHtml(section)}</b>\n\n` + lines.join('\n'), keyboard };
}

async function sendList(env, chatId, tasks, sections, title) {
  if (tasks.length === 0) {
    return sendMessage(env, chatId, '📭 Список пуст. Напиши текст задачи, чтобы добавить.');
  }
  const open = tasks.filter((t) => !t.done).length;
  const hasDone = tasks.some((t) => t.done);

  // Заголовок (+ кнопка очистки выполненных)
  await sendMessage(env, chatId, `${title || '📋 <b>Задачи</b>'} — в работе: ${open}`,
    hasDone ? [[{ text: '🧹 Убрать выполненные', callback_data: 'clear:0' }]] : undefined);

  // Все разделы по порядку: из списка разделов + встретившиеся в задачах
  const all = [...sections];
  for (const t of tasks) {
    const s = t.section || DEFAULT_SECTION;
    if (!all.includes(s)) all.push(s);
  }
  for (const sec of all) {
    const view = renderSection(tasks, sec);
    if (view) await sendMessage(env, chatId, view.text, view.keyboard);
  }
}

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

// ================= Даты (МСК = UTC+3) =================

function parseDeadline(str) {
  const m = str.toLowerCase().trim().match(/^(сегодня|завтра|\d{1,2}\.\d{1,2}(?:\.\d{4})?)(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const nowMsk = new Date(Date.now() + MSK_MS);
  let y = nowMsk.getUTCFullYear(), mo = nowMsk.getUTCMonth(), d = nowMsk.getUTCDate();
  if (m[1] === 'завтра') d += 1;
  else if (m[1] !== 'сегодня') {
    const p = m[1].split('.');
    d = parseInt(p[0], 10);
    mo = parseInt(p[1], 10) - 1;
    if (mo > 11 || d > 31) return null;
    if (p[2]) y = parseInt(p[2], 10);
    else if (mo < nowMsk.getUTCMonth() || (mo === nowMsk.getUTCMonth() && d < nowMsk.getUTCDate())) y += 1;
  }
  const hh = m[2] !== undefined ? parseInt(m[2], 10) : 10;
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

// ================= Утилиты =================

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
