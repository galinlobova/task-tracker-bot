/**
 * Telegram Task Tracker Bot — Cloudflare Worker
 *
 * Хранение: Cloudflare KV (binding: TASKS)
 * Секреты: BOT_TOKEN, SECRET
 *
 * Возможности:
 *   любой текст      — добавить задачу
 *   /list            — список задач с инлайн-кнопками (✅ выполнить, 🗑 удалить)
 *   /done N, /undo N, /del N, /clear, /help — текстовые команды тоже работают
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    try {
      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
      } else if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const reply = await handleCommand(env, chatId, update.message.text.trim());
        if (reply) {
          await sendMessage(env, chatId, reply.text, reply.keyboard);
        }
      }
    } catch (e) {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) await sendMessage(env, chatId, '⚠️ Ошибка: ' + e.message);
    }

    return new Response('OK');
  },
};

// ---------- Обработка нажатий на инлайн-кнопки ----------

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const key = `tasks:${chatId}`;
  const tasks = JSON.parse((await env.TASKS.get(key)) || '[]');

  const [action, idStr] = cq.data.split(':');
  let notice = '';

  if (action === 'done' || action === 'undo' || action === 'del') {
    const i = tasks.findIndex((t) => String(t.id) === idStr);
    if (i === -1) {
      notice = 'Задача уже не существует';
    } else if (action === 'done') {
      tasks[i].done = true;
      notice = '✅ Выполнено';
    } else if (action === 'undo') {
      tasks[i].done = false;
      notice = '↩️ Возвращено в работу';
    } else {
      tasks.splice(i, 1);
      notice = '🗑 Удалено';
    }
  } else if (action === 'clear') {
    const before = tasks.length;
    const remaining = tasks.filter((t) => !t.done);
    tasks.length = 0;
    tasks.push(...remaining);
    notice = `🧹 Удалено выполненных: ${before - tasks.length}`;
  }

  await env.TASKS.put(key, JSON.stringify(tasks));

  // Всплывающее уведомление + обновление списка в том же сообщении
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: notice });

  const view = renderList(tasks);
  await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: view.text,
    parse_mode: 'HTML',
    reply_markup: view.keyboard ? { inline_keyboard: view.keyboard } : { inline_keyboard: [] },
  });
}

// ---------- Обработка текстовых команд ----------

async function handleCommand(env, chatId, text) {
  const key = `tasks:${chatId}`;
  const tasks = JSON.parse((await env.TASKS.get(key)) || '[]');
  const save = () => env.TASKS.put(key, JSON.stringify(tasks));

  if (text === '/start' || text === '/help') {
    return {
      text: [
        '📋 <b>Трекер задач</b>',
        '',
        'Просто напиши текст — я добавлю задачу.',
        'В списке (/list) под каждой задачей есть кнопки:',
        '✅ — выполнить, 🗑 — удалить.',
        '',
        '<b>Команды:</b>',
        '/list — список задач',
        '/done N — отметить выполненной',
        '/undo N — вернуть в работу',
        '/del N — удалить задачу',
        '/clear — убрать все выполненные',
      ].join('\n'),
    };
  }

  if (text === '/list' || text === '/l') {
    return renderList(tasks);
  }

  let m = text.match(/^\/(?:done|d)\s+(\d+)$/);
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    if (!tasks[i]) return { text: `Задачи №${m[1]} нет. Всего задач: ${tasks.length}.` };
    tasks[i].done = true;
    await save();
    return renderList(tasks);
  }

  m = text.match(/^\/undo\s+(\d+)$/);
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    if (!tasks[i]) return { text: `Задачи №${m[1]} нет.` };
    tasks[i].done = false;
    await save();
    return renderList(tasks);
  }

  m = text.match(/^\/del\s+(\d+)$/);
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    if (!tasks[i]) return { text: `Задачи №${m[1]} нет.` };
    tasks.splice(i, 1);
    await save();
    return renderList(tasks);
  }

  if (text === '/clear') {
    const remaining = tasks.filter((t) => !t.done);
    tasks.length = 0;
    tasks.push(...remaining);
    await save();
    return renderList(tasks);
  }

  if (text.startsWith('/')) {
    return { text: 'Не знаю такую команду. Напиши /help для справки.' };
  }

  // Любой текст — новая задача (id нужен для кнопок)
  tasks.push({ id: Date.now(), text, done: false });
  await save();
  return { text: `➕ Добавлено (№${tasks.length}): ${escapeHtml(text)}` };
}

// ---------- Отрисовка списка с кнопками ----------

function renderList(tasks) {
  if (tasks.length === 0) {
    return { text: '📭 Список пуст. Напиши текст задачи, чтобы добавить.' };
  }

  const lines = tasks.map((t, i) => {
    const num = i + 1;
    return t.done
      ? `${num}. ✅ <s>${escapeHtml(t.text)}</s>`
      : `${num}. ⬜ ${escapeHtml(t.text)}`;
  });
  const open = tasks.filter((t) => !t.done).length;

  // Одна строка кнопок на задачу: "✅ 1" или "↩️ 1" + "🗑 1"
  const keyboard = tasks.map((t, i) => {
    const num = i + 1;
    const short = t.text.length > 20 ? t.text.slice(0, 20) + '…' : t.text;
    return [
      t.done
        ? { text: `↩️ ${num}. ${short}`, callback_data: `undo:${t.id}` }
        : { text: `✅ ${num}. ${short}`, callback_data: `done:${t.id}` },
      { text: '🗑', callback_data: `del:${t.id}` },
    ];
  });

  if (tasks.some((t) => t.done)) {
    keyboard.push([{ text: '🧹 Убрать выполненные', callback_data: 'clear:0' }]);
  }

  return {
    text: `📋 <b>Задачи</b> (в работе: ${open})\n\n` + lines.join('\n'),
    keyboard,
  };
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Telegram API ----------

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
