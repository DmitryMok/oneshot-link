const express = require('express');
const cors    = require('cors');
const path    = require('path');

const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', 1); // корректный IP за nginx/reverse proxy

// 301-редирект с diworld.pro на основной домен (для SEO)
// TODO: раскомментировать когда 1qaz.su заработает
// app.use((req, res, next) => {
//     if (req.hostname && req.hostname.includes('diworld.pro')) {
//         return res.redirect(301, 'https://1qaz.su' + req.originalUrl);
//     }
//     next();
// });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Хранилища ─────────────────────────────────────────────────────────────────
const links      = new Map(); // PIN -> { url, expiresAt, createdAt, sessionId, status }
const ipAttempts = new Map(); // IP  -> { count, blockUntil }
const ipCreates  = new Map(); // IP  -> { count, windowStart }
const clients    = new Map(); // sessionId -> res (SSE)

const MAX_CONTENT_LENGTH = 2000;
const TTL_MS        = 10 * 60 * 1000;
const MAX_ATTEMPTS  = 3;
const BLOCK_TIME_MS = 5 * 60 * 1000;
const MAX_CREATES_PER_WINDOW = 10;
const CREATE_WINDOW_MS       = 10 * 60 * 1000;

// ── Утилиты ───────────────────────────────────────────────────────────────────
function getActiveCount() {
    const now = Date.now();
    return Array.from(links.values()).filter(l => l.status === 'active' && l.expiresAt > now).length;
}

function generatePin() {
    const isFiveDigits = getActiveCount() > 8000;
    const min = isFiveDigits ? 10000 : 1000;
    const max = isFiveDigits ? 99999 : 9999;
    let pin, attempts = 0;
    do {
        pin = Math.floor(Math.random() * (max - min + 1) + min).toString();
        if (++attempts > 50) throw new Error("Слишком много коллизий");
    } while (links.has(pin));
    return pin;
}

// Blacklist опасных протоколов (javascript:, data:, vbscript: — исполняются браузером)
function isSafeContent(str) {
    if (!str || !str.trim())
        return { ok: false, reason: 'Пустое содержимое' };
    if (str.length > MAX_CONTENT_LENGTH)
        return { ok: false, reason: `Превышен лимит ${MAX_CONTENT_LENGTH} символов` };
    if (/^\s*(javascript|data|vbscript)\s*:/i.test(str))
        return { ok: false, reason: 'Опасный протокол' };
    return { ok: true, reason: null };
}

// Извлекаем реальный IP (с учётом reverse proxy)
function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    const ip  = fwd ? fwd.split(',')[0].trim() : req.ip;
    return ip.replace(/^::ffff:/, ''); // убираем IPv4-mapped IPv6 префикс
}

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/events/:sessionId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // отключает буферизацию в Passenger/nginx
    clients.set(req.params.sessionId, res);
    req.on('close', () => clients.delete(req.params.sessionId));
});

// ── Конфиг (длина PIN) ────────────────────────────────────────────────────────
// ── Статус ссылки (polling вместо SSE) ───────────────────────────────────────
app.get('/api/status/:pin', (req, res) => {
    const { pin } = req.params;
    const { sessionId } = req.query;
    const link = links.get(pin);
    if (!link || link.sessionId !== sessionId) return res.json({ status: 'unknown' });
    if (Date.now() > link.expiresAt) return res.json({ status: 'expired' });
    res.json({ status: link.status, openedAt: link.openedAt || null });
});

app.get('/api/config', (req, res) => {
    res.json({ pinLength: getActiveCount() > 8000 ? 5 : 4 });
});

// ── Создание ──────────────────────────────────────────────────────────────────
app.post('/api/create', async (req, res) => {
    const { url: content, sessionId } = req.body;
    const ip = getClientIp(req);

    // Rate limiting на генерацию
    const now = Date.now();
    const cr  = ipCreates.get(ip) || { count: 0, windowStart: now };
    if (now - cr.windowStart > CREATE_WINDOW_MS) { cr.count = 0; cr.windowStart = now; }
    cr.count++;
    ipCreates.set(ip, cr);
    if (cr.count > MAX_CREATES_PER_WINDOW)
        return res.status(429).json({ error: 'Слишком много запросов. Подождите несколько минут.' });

    const check = isSafeContent(content);
    if (!check.ok)
        return res.status(400).json({ error: check.reason });

    try {
        const pin       = generatePin();
        const createdAt = Date.now();
        const expiresAt = createdAt + TTL_MS;

        links.set(pin, { url: content.trim(), expiresAt, createdAt, sessionId, status: 'active' });

        // QR кодирует оригинальный контент (URL или текст)
        // Генерируем 2× размер для чёткости на Retina-экранах
        let qr = null;
        try {
            qr = await QRCode.toDataURL(content.trim(), {
                width: 320,
                margin: 1,
                color: { dark: '#1f2937', light: '#ffffff' }
            });
        } catch {}

        res.json({ pin, expiresAt, qr });
    } catch {
        res.status(500).json({ error: "Ошибка генерации PIN" });
    }
});

// ── Получение ─────────────────────────────────────────────────────────────────
app.get('/api/link/:pin', (req, res) => {
    const ip  = getClientIp(req);
    const pin = req.params.pin;

    const ipData = ipAttempts.get(ip) || { count: 0, blockUntil: 0 };
    if (ipData.blockUntil > Date.now())
        return res.status(429).json({ error: "Слишком много попыток. Попробуйте с другого устройства или подождите." });

    const linkData = links.get(pin);
    if (!linkData || (linkData.status !== 'active' && linkData.status !== 'opened') || linkData.expiresAt < Date.now()) {
        ipData.count++;
        if (ipData.count >= MAX_ATTEMPTS) ipData.blockUntil = Date.now() + BLOCK_TIME_MS;
        ipAttempts.set(ip, ipData);
        return res.status(404).json({ error: "Код не найден или срок действия истёк." });
    }

    ipAttempts.delete(ip);

    // Сохраняем время открытия для polling
    if (!linkData.openedAt) {
        linkData.openedAt = new Date().toLocaleTimeString();
        linkData.status = 'opened';
    }

    res.json({ url: linkData.url });
});

// ── Удаление ссылки владельцем ────────────────────────────────────────────────
app.delete('/api/link/:pin', (req, res) => {
    const { pin } = req.params;
    const { sessionId } = req.body;
    const linkData = links.get(pin);
    if (!linkData) return res.status(404).json({ error: 'Ссылка не найдена' });
    if (linkData.sessionId !== sessionId) return res.status(403).json({ error: 'Нет доступа' });
    links.delete(pin);
    res.json({ ok: true });
});

// ── Сброс таймера ─────────────────────────────────────────────────────────────
app.post('/api/refresh', (req, res) => {
    const { pin, sessionId } = req.body;
    const linkData = links.get(pin);
    if (!linkData || linkData.status !== 'active' || linkData.expiresAt < Date.now())
        return res.status(404).json({ error: "Ссылка не найдена или уже истекла" });
    if (linkData.sessionId !== sessionId)
        return res.status(403).json({ error: "Нет доступа" });
    linkData.expiresAt = Date.now() + TTL_MS;
    res.json({ ok: true, expiresAt: linkData.expiresAt });
});

// ── Автоочистка (каждую минуту) ───────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [pin, data] of links.entries()) {
        if (data.expiresAt < now) links.delete(pin);
    }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
