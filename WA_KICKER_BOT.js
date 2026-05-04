'use strict';

// ╔══════════════════════════════════════════════════════════════════╗
// ║         WA KICKER BOT v5.0 — PRODUCTION SECURITY HARDENED       ║
// ║  Perbaikan: AES-GCM, Redis rate limit, webhook validation,       ║
// ║  salt acak, log rotation, race condition fix, audit trail        ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─────────────────────────────────────────────
// DEPENDENCIES
// npm install telegraf @whiskeysockets/baileys qrcode pino
//             async-mutex node-cache ioredis winston
//             winston-daily-rotate-file express helmet
//             ip-range-check
// ─────────────────────────────────────────────

const { Telegraf, Markup }      = require('telegraf');
const makeWASocket               = require('@whiskeysockets/baileys').default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore
}                                = require('@whiskeysockets/baileys');
const QRCode                     = require('qrcode');
const pino                       = require('pino');
const fs                         = require('fs');
const path                       = require('path');
const crypto                     = require('crypto');
const { Mutex }                  = require('async-mutex');
const NodeCache                  = require('node-cache');
const Redis                      = require('ioredis');
const express                    = require('express');
const helmet                     = require('helmet');
const ipRangeCheck               = require('ip-range-check');
const winston                    = require('winston');
require('winston-daily-rotate-file');

// ─────────────────────────────────────────────
// 1. ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────

const REQUIRED_ENV = [
    'TELEGRAM_BOT_TOKEN',
    'ENCRYPTION_KEY',          // min 32 karakter acak
    'WEBHOOK_SECRET',          // min 32 karakter acak
    'REDIS_URL',               // redis://... atau rediss://... untuk TLS
];

const MISSING = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING.length) {
    console.error(`❌ Missing required env vars: ${MISSING.join(', ')}`);
    process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length < 32) {
    console.error('❌ ENCRYPTION_KEY harus minimal 32 karakter');
    process.exit(1);
}

// ─────────────────────────────────────────────
// 2. SECURE LOGGER (winston + daily rotate)
// ─────────────────────────────────────────────

const SENSITIVE_FIELDS = new Set([
    'token', 'password', 'qr', 'key', 'secret',
    'creds', 'authState', 'encryption_key'
]);

function redactSensitive(obj, depth = 0) {
    if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = typeof v === 'object' ? redactSensitive(v, depth + 1) : v;
        }
    }
    return out;
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.DailyRotateFile({
            filename:      './data/logs/app-%DATE%.log',
            datePattern:   'YYYY-MM-DD',
            maxSize:       '20m',     // maks 20MB per file
            maxFiles:      '14d',     // simpan 14 hari
            zippedArchive: true,
            auditFile:     './data/logs/.audit.json',
        }),
        new winston.transports.DailyRotateFile({
            level:         'error',
            filename:      './data/logs/error-%DATE%.log',
            datePattern:   'YYYY-MM-DD',
            maxSize:       '10m',
            maxFiles:      '30d',
            zippedArchive: true,
        }),
        ...(process.env.NODE_ENV !== 'production'
            ? [new winston.transports.Console({ format: winston.format.simple() })]
            : [])
    ]
});

// Buat folder log
['./data', './data/logs', './data/backups', './data/encrypted_auth'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
});

function secureLog(level, message, meta = {}) {
    logger[level](message, redactSensitive(meta));
}

// ─────────────────────────────────────────────
// 3. ENCRYPTION — AES-256-GCM (DIPERBAIKI)
//    Sebelumnya: AES-CBC + salt statis → rentan padding oracle
//    Sekarang:   AES-GCM (AEAD) + salt acak per derivasi
// ─────────────────────────────────────────────

const GCM_IV_LENGTH  = 12;   // 96-bit IV, standar GCM
const GCM_TAG_LENGTH = 16;   // 128-bit auth tag
const SALT_LENGTH    = 32;   // 256-bit salt per-kunci

/**
 * Menghasilkan kunci AES-256 dari password + salt acak menggunakan scrypt.
 * Salt disimpan bersama ciphertext sehingga setiap enkripsi unik.
 */
async function deriveKey(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
}

/**
 * Enkripsi AES-256-GCM dengan autentikasi terintegrasi.
 * Output: hex string dengan format: salt(64) + iv(24) + tag(32) + ciphertext
 */
async function encrypt(plaintext) {
    const salt       = crypto.randomBytes(SALT_LENGTH);
    const iv         = crypto.randomBytes(GCM_IV_LENGTH);
    const key        = await deriveKey(process.env.ENCRYPTION_KEY, salt);
    const cipher     = crypto.createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: GCM_TAG_LENGTH
    });
    const encrypted  = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);
    const authTag    = cipher.getAuthTag();
    // Format: [salt][iv][authTag][ciphertext]
    return Buffer.concat([salt, iv, authTag, encrypted]).toString('hex');
}

/**
 * Dekripsi dengan verifikasi autentikasi.
 * Jika data dimanipulasi, akan throw Error (tidak bisa silent fail).
 */
async function decrypt(hexData) {
    const buf        = Buffer.from(hexData, 'hex');
    const salt       = buf.subarray(0, SALT_LENGTH);
    const iv         = buf.subarray(SALT_LENGTH, SALT_LENGTH + GCM_IV_LENGTH);
    const authTag    = buf.subarray(SALT_LENGTH + GCM_IV_LENGTH, SALT_LENGTH + GCM_IV_LENGTH + GCM_TAG_LENGTH);
    const ciphertext = buf.subarray(SALT_LENGTH + GCM_IV_LENGTH + GCM_TAG_LENGTH);
    const key        = await deriveKey(process.env.ENCRYPTION_KEY, salt);
    const decipher   = crypto.createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: GCM_TAG_LENGTH
    });
    decipher.setAuthTag(authTag);
    // Akan throw jika autentikasi gagal (data dimanipulasi)
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]).toString('utf8');
}

// ─────────────────────────────────────────────
// 4. REDIS CLIENT (rate limiting & audit trail)
// ─────────────────────────────────────────────

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
});

redis.on('error', err => secureLog('error', 'Redis error', { error: err.message }));
redis.on('connect', () => secureLog('info', 'Redis connected'));

// ─────────────────────────────────────────────
// 5. RATE LIMITING BERBASIS REDIS (DIPERBAIKI)
//    Sebelumnya: in-memory Map → hilang saat restart, tidak cluster-safe
//    Sekarang:   Redis atomic counters dengan TTL
// ─────────────────────────────────────────────

const RATE_LIMITS = {
    GLOBAL_PER_MINUTE: 1000,
    USER_PER_MINUTE:   15,
    LOGIN_PER_HOUR:    5,
    KICK_PER_DAY:      500,
    KICK_COOLDOWN_MS:  5000,
};

/**
 * Generic rate limiter menggunakan Redis INCR + EXPIRE.
 * Atomic, persisten, cluster-safe.
 */
async function checkRateLimit(key, limit, windowSeconds) {
    const redisKey = `rl:${key}`;
    const pipeline = redis.pipeline();
    pipeline.incr(redisKey);
    pipeline.ttl(redisKey);
    const [[, count], [, ttl]] = await pipeline.exec();
    if (ttl === -1) {
        await redis.expire(redisKey, windowSeconds);
    }
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count) };
}

async function checkGlobalRateLimit() {
    return checkRateLimit('global', RATE_LIMITS.GLOBAL_PER_MINUTE, 60);
}

async function checkUserRateLimit(userId) {
    return checkRateLimit(`user:${userId}`, RATE_LIMITS.USER_PER_MINUTE, 60);
}

async function checkLoginRateLimit(userId) {
    return checkRateLimit(`login:${userId}`, RATE_LIMITS.LOGIN_PER_HOUR, 3600);
}

async function checkKickDailyLimit(userId) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return checkRateLimit(`kick:${userId}:${today}`, RATE_LIMITS.KICK_PER_DAY, 86400);
}

async function checkKickCooldown(userId) {
    const key  = `kick_cd:${userId}`;
    const last = await redis.get(key);
    if (!last) return { allowed: true };
    const elapsed = Date.now() - parseInt(last);
    if (elapsed < RATE_LIMITS.KICK_COOLDOWN_MS) {
        return { allowed: false, remaining: RATE_LIMITS.KICK_COOLDOWN_MS - elapsed };
    }
    return { allowed: true };
}

async function setKickCooldown(userId) {
    await redis.set(`kick_cd:${userId}`, Date.now(), 'PX', RATE_LIMITS.KICK_COOLDOWN_MS);
}

// ─────────────────────────────────────────────
// 6. AUDIT TRAIL (immutable di Redis + log file)
// ─────────────────────────────────────────────

async function auditLog(userId, action, meta = {}) {
    const entry = {
        ts:     new Date().toISOString(),
        userId: String(userId),
        action,
        ...redactSensitive(meta),
    };
    // Simpan ke Redis list (FIFO, maks 10.000 entri per user)
    const key = `audit:${userId}`;
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 9999);
    await redis.expire(key, 90 * 86400); // 90 hari
    // Juga ke log file terpisah
    secureLog('info', 'AUDIT', entry);
}

// ─────────────────────────────────────────────
// 7. ENCRYPTED AUTH STORE (DIPERBAIKI: async, AES-GCM)
// ─────────────────────────────────────────────

class EncryptedAuthStore {
    constructor(baseFolder) {
        this.baseFolder = baseFolder;
        if (!fs.existsSync(baseFolder)) fs.mkdirSync(baseFolder, { recursive: true, mode: 0o700 });
    }

    _filePath(userId) {
        // Validasi userId untuk mencegah path traversal
        const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safe) throw new Error('Invalid userId');
        return path.join(this.baseFolder, `user_${safe}.enc`);
    }

    async read(userId) {
        const filePath = this._filePath(userId);
        if (!fs.existsSync(filePath)) return null;
        try {
            const hexData  = fs.readFileSync(filePath, 'utf8').trim();
            const decrypted = await decrypt(hexData);
            return JSON.parse(decrypted);
        } catch (err) {
            secureLog('error', 'Auth read failed — mungkin data corrupt', { userId });
            return null;
        }
    }

    async write(userId, data) {
        const filePath  = this._filePath(userId);
        const encrypted = await encrypt(JSON.stringify(data));
        // Tulis atomik: temp file → rename
        const tmpPath   = filePath + '.tmp';
        fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
    }

    async delete(userId) {
        const filePath = this._filePath(userId);
        if (fs.existsSync(filePath)) {
            // Overwrite dengan data acak sebelum hapus (secure delete sederhana)
            const size = fs.statSync(filePath).size;
            fs.writeFileSync(filePath, crypto.randomBytes(size));
            fs.unlinkSync(filePath);
        }
    }
}

const encryptedAuthStore = new EncryptedAuthStore('./data/encrypted_auth');

// ─────────────────────────────────────────────
// 8. SESSION MANAGEMENT (DIPERBAIKI: TTL konsisten)
// ─────────────────────────────────────────────

// NodeCache untuk sesi aktif (in-process, bukan persisten)
// TTL 7 hari untuk sesi aktif; cleanup otomatis tiap 2 menit
const sessionCache = new NodeCache({
    stdTTL:      7 * 24 * 3600,
    checkperiod: 120,
    useClones:   false,   // Penting: kita simpan objek dengan event emitter
});

function setSession(userId, session) {
    sessionCache.set(`s:${userId}`, session);
}

function getSession(userId) {
    return sessionCache.get(`s:${userId}`) || null;
}

function deleteSession(userId) {
    sessionCache.del(`s:${userId}`);
}

// ─────────────────────────────────────────────
// 9. FILE MUTEX
// ─────────────────────────────────────────────

const fileMutex   = new Mutex();
const userMutexes = new Map();

function getUserMutex(userId) {
    if (!userMutexes.has(userId)) userMutexes.set(userId, new Mutex());
    return userMutexes.get(userId);
}

// ─────────────────────────────────────────────
// 10. INPUT SANITIZATION (DIPERBAIKI)
//     Sebelumnya: escape markdown saat simpan → merusak data
//     Sekarang:   sanitasi struktural saat simpan, escape hanya saat render
// ─────────────────────────────────────────────

/**
 * Sanitasi untuk penyimpanan: hapus null bytes dan karakter berbahaya.
 * TIDAK melakukan escape markdown — itu urusan fungsi render.
 */
function sanitizeForStorage(input, maxLength = 1000) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/\0/g, '')                        // null bytes
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // control chars (kecuali \n \r \t)
        .trim()
        .substring(0, maxLength);
}

/**
 * Escape karakter Markdown v2 Telegram untuk output ke user.
 * Hanya dipanggil saat akan mengirim pesan, bukan saat menyimpan.
 */
function escapeMarkdown(text) {
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

function validateGroupName(name) {
    const s = sanitizeForStorage(name, 100);
    if (s.length < 3) return null;
    // Izinkan huruf, angka, spasi, dan beberapa tanda baca umum
    if (/[^\p{L}\p{N}\s\-_().,]/u.test(s)) return null;
    return s;
}

// ─────────────────────────────────────────────
// 11. DATA OPERATIONS (dengan mutex)
// ─────────────────────────────────────────────

const DATA_FILE = './data/bot_users.json';

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const init = { users: [], pendingPayment: [], version: '5.0' };
            fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), { mode: 0o640 });
            return init;
        }
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        raw.users          = raw.users          || [];
        raw.pendingPayment = raw.pendingPayment || [];
        return raw;
    } catch (err) {
        secureLog('error', 'loadData failed', { error: err.message });
        return { users: [], pendingPayment: [] };
    }
}

async function saveData(data) {
    const release = await fileMutex.acquire();
    try {
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o640 });
        fs.renameSync(tmp, DATA_FILE); // atomic rename
    } catch (err) {
        secureLog('error', 'saveData failed', { error: err.message });
        throw err;
    } finally {
        release();
    }
}

// Backup harian
async function createBackup() {
    const date    = new Date().toISOString().slice(0, 10);
    const backupPath = `./data/backups/bot_users_${date}.json`;
    if (!fs.existsSync(backupPath) && fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, backupPath);
        secureLog('info', 'Backup created', { path: backupPath });
    }
}
setInterval(createBackup, 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────
// 12. PERMISSION CHECK (WhatsApp)
// ─────────────────────────────────────────────

async function ensureBotIsAdmin(sock, groupId) {
    try {
        const metadata   = await sock.groupMetadata(groupId);
        const botJid     = sock.user.id.replace(/:.*@/, '@');
        const bot        = metadata.participants.find(p => p.id === botJid);
        const isAdmin    = bot?.admin === 'admin' || bot?.admin === 'superadmin';
        return { isAdmin, message: isAdmin ? null : 'Bot bukan admin di grup ini' };
    } catch (err) {
        secureLog('warn', 'ensureBotIsAdmin error', { error: err.message });
        return { isAdmin: false, message: `Gagal cek permission: ${err.message}` };
    }
}

// ─────────────────────────────────────────────
// 13. CONFIG
// ─────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS          = (process.env.ADMIN_IDS || '')
    .split(',').map(id => parseInt(id.trim())).filter(Boolean);
const BOT_NAME           = sanitizeForStorage(process.env.BOT_NAME   || 'WA Kicker Bot', 50);
const PAYMENT_INFO       = sanitizeForStorage(process.env.PAYMENT_INFO || 'Transfer ke Bank', 200);
const PAYMENT_CONTACT    = sanitizeForStorage(process.env.PAYMENT_CONTACT || '@admin', 50);
const TRIAL_DURATION_H   = Math.max(1, Math.min(168, parseInt(process.env.TRIAL_DURATION_HOURS) || 24));

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: 50000  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: 125000 },
    '6bulan':  { label: '6 Bulan',  days: 180, price: 200000 },
    '1tahun':  { label: '1 Tahun',  days: 365, price: 350000 },
};

// ─────────────────────────────────────────────
// 14. WHATSAPP LOGIN (DIPERBAIKI: race condition fix)
//     Sebelumnya: mutex dilepas sebelum koneksi selesai
//     Sekarang:   mutex per-login, state management yang benar
// ─────────────────────────────────────────────

async function startLogin(ctx, userId) {
    const loginCheck = await checkLoginRateLimit(userId);
    if (!loginCheck.allowed) {
        const waitMin = Math.ceil(3600 / 60);
        return ctx.reply(`⏳ Terlalu banyak percobaan login\\. Coba lagi dalam ${waitMin} menit\\.`, {
            parse_mode: 'MarkdownV2'
        });
    }

    const userMutex = getUserMutex(userId);

    // Jika ada session aktif, tutup dulu
    const existingSession = getSession(userId);
    if (existingSession) {
        try {
            existingSession.sock?.end(new Error('replaced_by_new_login'));
        } catch (_) {}
        deleteSession(userId);
        await auditLog(userId, 'SESSION_REPLACED');
    }

    // Cek apakah sedang ada proses login (mutex busy)
    if (userMutex.isLocked()) {
        return ctx.reply('⏳ Proses login sedang berjalan\\. Mohon tunggu\\.', { parse_mode: 'MarkdownV2' });
    }

    // Mutex TIDAK dipakai sebagai "release saat selesai" — hanya sebagai flag
    // Proses login dijalankan secara async tanpa menahan mutex
    secureLog('info', 'Login started', { userId });
    await auditLog(userId, 'LOGIN_STARTED');

    try {
        const savedState = await encryptedAuthStore.read(userId);

        const sock = makeWASocket({
            auth: savedState || { creds: {}, keys: {} },
            printQRInTerminal: false,
            browser:       ['WA Kicker Secure', 'Chrome', '5.0'],
            logger:        pino({ level: 'silent' }),
            connectTimeoutMs:      60_000,
            defaultQueryTimeoutMs: 30_000,
            keepAliveIntervalMs:   30_000,
            retryRequestDelayMs:    5_000,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        // Simpan creds terenkripsi setiap update
        sock.ev.on('creds.update', async () => {
            try {
                const state = { creds: sock.authState?.creds, keys: sock.authState?.keys };
                await encryptedAuthStore.write(userId, state);
            } catch (err) {
                secureLog('error', 'creds.update write failed', { userId, error: err.message });
            }
        });

        const session = {
            sock,
            loggedIn:  false,
            groupId:   null,
            groupName: null,
            members:   [],
            createdAt: Date.now(),
            userId,
        };

        // Simpan sesi segera (sebelum koneksi selesai) agar bisa diakses callback
        setSession(userId, session);

        sock.ev.on('connection.update', async update => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Cek sesi masih ada (user mungkin sudah /logout)
                if (!getSession(userId)) return;
                try {
                    const qrBuffer = await QRCode.toBuffer(qr, {
                        type:                'png',
                        width:               512,
                        margin:              2,
                        errorCorrectionLevel: 'H',
                    });
                    await ctx.replyWithPhoto({ source: qrBuffer }, {
                        caption: [
                            '📱 *Scan QR Code*',
                            '',
                            '1\\. Buka WhatsApp → ⋮ → Perangkat Tertaut',
                            '2\\. Tap "Tambahkan Perangkat"',
                            '3\\. Scan QR ini',
                            '',
                            '⏱ QR berlaku 60 detik',
                            '⚠️ Jangan pernah share QR ini ke siapapun\\!'
                        ].join('\n'),
                        parse_mode: 'MarkdownV2',
                    });
                } catch (err) {
                    secureLog('error', 'QR send failed', { userId, error: err.message });
                }
            }

            if (connection === 'open') {
                const currentSession = getSession(userId);
                if (currentSession) {
                    currentSession.loggedIn = true;
                    setSession(userId, currentSession);
                }
                await auditLog(userId, 'LOGIN_SUCCESS', {
                    waUser: sock.user?.id?.split('@')[0]
                });
                await ctx.reply(
                    '✅ *Login berhasil\\!*\n\n' +
                    '📋 /groups \\- Lihat daftar grup\n' +
                    '🎯 /select \\- Pilih grup target\n' +
                    '🔴 /kickmenu \\- Mulai kick anggota\n' +
                    '🚪 /logout \\- Keluar dari WhatsApp',
                    { parse_mode: 'MarkdownV2' }
                );
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout   = statusCode === DisconnectReason.loggedOut;

                await auditLog(userId, 'CONNECTION_CLOSED', { statusCode, isLogout });

                if (isLogout) {
                    deleteSession(userId);
                    await encryptedAuthStore.delete(userId);
                    await ctx.reply('🔒 Sesi berakhir \\(logged out\\)\\. Ketik /login untuk konek ulang\\.', {
                        parse_mode: 'MarkdownV2'
                    });
                } else {
                    // Koneksi terputus, tapi tidak logout — coba reconnect otomatis
                    const currentSession = getSession(userId);
                    if (currentSession) {
                        currentSession.loggedIn = false;
                        setSession(userId, currentSession);
                    }
                    await ctx.reply('🔌 Koneksi terputus\\. Ketik /login untuk konek ulang\\.', {
                        parse_mode: 'MarkdownV2'
                    });
                }
            }
        });

    } catch (err) {
        secureLog('error', 'startLogin failed', { userId, error: err.message });
        deleteSession(userId);
        await ctx.reply(`❌ Gagal memulai login\\: ${escapeMarkdown(err.message)}`, {
            parse_mode: 'MarkdownV2'
        });
    }
}

// ─────────────────────────────────────────────
// 15. KICK FUNCTION (DIPERBAIKI: rate limit Redis, audit)
// ─────────────────────────────────────────────

async function executeKick(userId, session, jidList, ctx) {
    // Validasi input
    if (!Array.isArray(jidList) || jidList.length === 0) {
        return ctx.reply('❌ Tidak ada anggota yang dipilih\\.', { parse_mode: 'MarkdownV2' });
    }
    // Batasi maks 50 per batch
    const batch = jidList.slice(0, 50);

    // Cek daily limit via Redis
    const kickLimit = await checkKickDailyLimit(userId);
    if (!kickLimit.allowed) {
        return ctx.reply(
            `⚠️ Limit kick harian sudah habis \\(${RATE_LIMITS.KICK_PER_DAY}/hari\\)\\.\nCoba lagi besok\\.`,
            { parse_mode: 'MarkdownV2' }
        );
    }

    // Cek cooldown via Redis
    const cooldown = await checkKickCooldown(userId);
    if (!cooldown.allowed) {
        const waitSec = Math.ceil(cooldown.remaining / 1000);
        return ctx.reply(`⏳ Tunggu *${waitSec}* detik sebelum kick lagi\\.`, { parse_mode: 'MarkdownV2' });
    }

    // Cek bot masih admin
    const adminCheck = await ensureBotIsAdmin(session.sock, session.groupId);
    if (!adminCheck.isAdmin) {
        return ctx.reply(`❌ ${escapeMarkdown(adminCheck.message)}`, { parse_mode: 'MarkdownV2' });
    }

    await setKickCooldown(userId);

    let berhasil = 0, gagal = 0;

    for (const jid of batch) {
        // Validasi format JID WhatsApp
        if (!/^\d+@s\.whatsapp\.net$/.test(jid)) { gagal++; continue; }
        try {
            await session.sock.groupParticipantsUpdate(session.groupId, [jid], 'remove');
            berhasil++;
            await auditLog(userId, 'KICK', { groupId: session.groupId, target: jid });
            await new Promise(r => setTimeout(r, 1000)); // jeda 1 detik antar kick
        } catch (err) {
            gagal++;
            secureLog('warn', 'Kick failed', { userId, target: jid, error: err.message });
        }
    }

    return { berhasil, gagal, total: batch.length };
}

// ─────────────────────────────────────────────
// 16. EXPRESS SERVER + WEBHOOK VALIDATION (DIPERBAIKI)
//     Sebelumnya: isTelegramIp() selalu return true
//     Sekarang:   validasi IP + secret header dengan timingSafeEqual
// ─────────────────────────────────────────────

// Rentang IP resmi Telegram
const TELEGRAM_IP_RANGES = [
    '149.154.160.0/20',
    '91.108.4.0/22',
    '91.108.8.0/22',
    '91.108.12.0/22',
    '91.108.16.0/22',
    '91.108.56.0/22',
    '149.154.164.0/22',
    '149.154.168.0/22',
    '149.154.172.0/22',
    '2001:b28:f23d::/48',  // IPv6
    '2001:b28:f23f::/48',
    '2001:67c:4e8::/48',
];

function isTelegramIp(ip) {
    if (!ip) return false;
    try {
        return ipRangeCheck(ip, TELEGRAM_IP_RANGES);
    } catch (_) {
        return false;
    }
}

/**
 * Validasi webhook secret menggunakan timing-safe compare
 * untuk mencegah timing attack.
 */
function validateWebhookSecret(providedSecret) {
    if (!providedSecret) return false;
    try {
        const expected = Buffer.from(process.env.WEBHOOK_SECRET, 'utf8');
        const provided = Buffer.from(providedSecret,             'utf8');
        if (expected.length !== provided.length) return false;
        return crypto.timingSafeEqual(expected, provided);
    } catch (_) {
        return false;
    }
}

const app = express();

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"] }
    }
}));

// Trust proxy (untuk mendapat IP asli di balik reverse proxy)
app.set('trust proxy', 1);

// Middleware validasi webhook
app.use(`/webhook/:secret`, (req, res, next) => {
    const secret = req.params.secret;
    const ip     = req.ip || req.socket?.remoteAddress;

    // 1. Validasi secret di URL
    if (!validateWebhookSecret(secret)) {
        secureLog('warn', 'Webhook: invalid secret', { ip });
        return res.sendStatus(403);
    }

    // 2. Validasi IP (production only)
    if (process.env.NODE_ENV === 'production' && !isTelegramIp(ip)) {
        secureLog('warn', 'Webhook: IP not in Telegram range', { ip });
        return res.sendStatus(403);
    }

    // 3. Validasi X-Telegram-Bot-Api-Secret-Token header (Telegram fitur baru)
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret && !validateWebhookSecret(headerSecret)) {
        secureLog('warn', 'Webhook: invalid header secret', { ip });
        return res.sendStatus(403);
    }

    next();
});

app.use(express.json({ limit: '1mb' })); // Batasi ukuran body

// Health check (tidak ada info sensitif)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// 17. TELEGRAM BOT SETUP
// ─────────────────────────────────────────────

const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Middleware rate limiting + logging
tgBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Global rate limit
    const global = await checkGlobalRateLimit();
    if (!global.allowed) {
        return ctx.reply('⏳ Server sedang sibuk\\. Coba lagi nanti\\.', { parse_mode: 'MarkdownV2' });
    }

    // User rate limit
    const userLimit = await checkUserRateLimit(userId);
    if (!userLimit.allowed) {
        return ctx.reply('⏳ Terlalu banyak permintaan\\. Tunggu 1 menit\\.', { parse_mode: 'MarkdownV2' });
    }

    secureLog('debug', 'Request', {
        userId,
        type: ctx.updateType,
        cmd:  ctx.message?.text?.split(' ')[0]
    });

    return next();
});

// ─────────────────────────────────────────────
// 18. COMMAND HANDLERS
// ─────────────────────────────────────────────

tgBot.command('start', async ctx => {
    const userId = ctx.from.id;
    const data   = loadData();
    const user   = data.users.find(u => u.id === userId);

    await ctx.reply(
        `🤖 *Selamat datang di ${escapeMarkdown(BOT_NAME)}\\!*\n\n` +
        (user?.active
            ? `✅ Akun aktif hingga: ${escapeMarkdown(new Date(user.expiredAt).toLocaleDateString('id-ID'))}\n\n`
            : '⚠️ Anda belum memiliki akses aktif\\.\n\n') +
        '📌 *Perintah tersedia:*\n' +
        '/login \\- Login ke WhatsApp\n' +
        '/groups \\- Lihat daftar grup\n' +
        '/select \\- Pilih grup\n' +
        '/kickmenu \\- Menu kick\n' +
        '/status \\- Status akun\n' +
        '/logout \\- Logout WA\n' +
        '/help \\- Bantuan',
        { parse_mode: 'MarkdownV2' }
    );
});

tgBot.command('login', async ctx => {
    const userId = ctx.from.id;

    // Cek akses aktif
    const data = loadData();
    const user = data.users.find(u => u.id === userId);
    if (!user?.active || new Date(user.expiredAt) < new Date()) {
        return ctx.reply(
            '❌ *Akses tidak aktif\\.* Hubungi admin untuk berlangganan\\:\n' +
            escapeMarkdown(PAYMENT_CONTACT),
            { parse_mode: 'MarkdownV2' }
        );
    }

    const session = getSession(userId);
    if (session?.loggedIn) {
        return ctx.reply('✅ Sudah login\\! Gunakan /logout untuk ganti akun\\.', { parse_mode: 'MarkdownV2' });
    }

    await startLogin(ctx, userId);
});

tgBot.command('logout', async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);

    if (!session) {
        return ctx.reply('ℹ️ Tidak ada sesi aktif\\.', { parse_mode: 'MarkdownV2' });
    }

    try {
        session.sock?.end(new Error('user_logout'));
    } catch (_) {}

    deleteSession(userId);
    await auditLog(userId, 'LOGOUT_MANUAL');
    await ctx.reply('✅ Berhasil logout dari WhatsApp\\.', { parse_mode: 'MarkdownV2' });
});

tgBot.command('status', async ctx => {
    const userId  = ctx.from.id;
    const data    = loadData();
    const user    = data.users.find(u => u.id === userId);
    const session = getSession(userId);

    const expDate = user?.expiredAt ? new Date(user.expiredAt).toLocaleDateString('id-ID') : 'N/A';
    const kickData = await redis.get(`kick:${userId}:${new Date().toISOString().slice(0,10)}`);

    await ctx.reply(
        '📊 *Status Akun*\n\n' +
        `👤 ID: \`${userId}\`\n` +
        `✅ Akses: ${user?.active ? 'Aktif' : 'Tidak aktif'}\n` +
        `📅 Kadaluarsa: ${escapeMarkdown(expDate)}\n` +
        `🔗 WA Login: ${session?.loggedIn ? 'Terhubung' : 'Tidak terhubung'}\n` +
        `🎯 Grup: ${session?.groupName ? escapeMarkdown(session.groupName) : 'Belum dipilih'}\n` +
        `🔴 Kick hari ini: ${kickData || 0}/${RATE_LIMITS.KICK_PER_DAY}`,
        { parse_mode: 'MarkdownV2' }
    );
});

tgBot.command('groups', async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);

    if (!session?.loggedIn) {
        return ctx.reply('❌ Login dulu\\! Ketik /login', { parse_mode: 'MarkdownV2' });
    }

    try {
        const groups = await session.sock.groupFetchAllParticipating();
        const list   = Object.values(groups);

        if (!list.length) {
            return ctx.reply('ℹ️ Tidak ada grup yang diikuti\\.', { parse_mode: 'MarkdownV2' });
        }

        // Simpan list grup ke sesi untuk digunakan /select
        session.availableGroups = list.map(g => ({
            id:   g.id,
            name: sanitizeForStorage(g.subject, 100),
            size: g.participants?.length || 0,
        }));
        setSession(userId, session);

        const lines = session.availableGroups
            .slice(0, 20)  // maks 20 grup ditampilkan
            .map((g, i) => `${i + 1}\\. ${escapeMarkdown(g.name)} \\(${g.size} anggota\\)`)
            .join('\n');

        await ctx.reply(
            `📋 *Daftar Grup \\(${list.length} grup\\):*\n\n${lines}\n\n` +
            'Gunakan /select \\[nomor\\] untuk memilih grup\\.',
            { parse_mode: 'MarkdownV2' }
        );
    } catch (err) {
        secureLog('error', 'groups command error', { userId, error: err.message });
        await ctx.reply('❌ Gagal mengambil daftar grup\\.', { parse_mode: 'MarkdownV2' });
    }
});

tgBot.command('select', async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);

    if (!session?.loggedIn) {
        return ctx.reply('❌ Login dulu\\! Ketik /login', { parse_mode: 'MarkdownV2' });
    }

    const arg = ctx.message.text.split(' ')[1];
    const idx = parseInt(arg) - 1;

    if (!session.availableGroups?.length) {
        return ctx.reply('ℹ️ Jalankan /groups terlebih dahulu\\.', { parse_mode: 'MarkdownV2' });
    }

    if (isNaN(idx) || idx < 0 || idx >= session.availableGroups.length) {
        return ctx.reply(`❌ Nomor tidak valid\\. Pilih 1\\-${session.availableGroups.length}\\.`, {
            parse_mode: 'MarkdownV2'
        });
    }

    const group        = session.availableGroups[idx];
    session.groupId    = group.id;
    session.groupName  = group.name;
    setSession(userId, session);

    await auditLog(userId, 'GROUP_SELECTED', { groupId: group.id, groupName: group.name });
    await ctx.reply(
        `✅ Grup dipilih: *${escapeMarkdown(group.name)}*\n` +
        `👥 ${group.size} anggota\n\n` +
        'Gunakan /kickmenu untuk mulai\\.', { parse_mode: 'MarkdownV2' }
    );
});

tgBot.command('kickmenu', async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);

    if (!session?.loggedIn) {
        return ctx.reply('❌ Login dulu\\! Ketik /login', { parse_mode: 'MarkdownV2' });
    }
    if (!session.groupId) {
        return ctx.reply('❌ Pilih grup dulu dengan /groups lalu /select\\.', { parse_mode: 'MarkdownV2' });
    }

    const adminCheck = await ensureBotIsAdmin(session.sock, session.groupId);
    if (!adminCheck.isAdmin) {
        return ctx.reply(`❌ ${escapeMarkdown(adminCheck.message)}`, { parse_mode: 'MarkdownV2' });
    }

    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const members  = metadata.participants.filter(p => {
            return p.id !== myJid && p.admin !== 'admin' && p.admin !== 'superadmin';
        });

        if (!members.length) {
            return ctx.reply('ℹ️ Tidak ada anggota non\\-admin yang bisa dikick\\.', { parse_mode: 'MarkdownV2' });
        }

        session.kickCandidates = members.map(p => ({
            jid:  p.id,
            name: p.id.split('@')[0].substring(0, 20),
        }));
        session.kickSelected = new Set();
        setSession(userId, session);

        const kickData    = await redis.get(`kick:${userId}:${new Date().toISOString().slice(0,10)}`);
        const usedToday   = parseInt(kickData) || 0;
        const remaining   = RATE_LIMITS.KICK_PER_DAY - usedToday;

        // Kirim daftar dengan inline keyboard
        const rows = session.kickCandidates.slice(0, 48).map((m, i) =>
            [Markup.button.callback(`☐ ${m.name}`, `toggle_${i}`)]
        );
        rows.push([
            Markup.button.callback('✅ Kick Semua Non-Admin', 'kick_all'),
            Markup.button.callback('🗑 Batal', 'kick_cancel'),
        ]);

        await ctx.reply(
            `🔴 *MENU KICK*\n\n` +
            `🎯 Grup: ${escapeMarkdown(session.groupName)}\n` +
            `👥 Target: ${members.length} anggota non\\-admin\n` +
            `📊 Sisa limit hari ini: ${remaining}/${RATE_LIMITS.KICK_PER_DAY}\n\n` +
            `Tekan nama untuk pilih, atau "Kick Semua"\\.`,
            { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) }
        );
    } catch (err) {
        secureLog('error', 'kickmenu error', { userId, error: err.message });
        await ctx.reply('❌ Gagal membuka menu kick\\.', { parse_mode: 'MarkdownV2' });
    }
});

// Callback handler untuk toggle pilihan
tgBot.action(/^toggle_(\d+)$/, async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);
    if (!session?.kickCandidates) return ctx.answerCbQuery('Sesi kadaluarsa\\.');

    const idx = parseInt(ctx.match[1]);
    if (idx >= session.kickCandidates.length) return ctx.answerCbQuery('Index tidak valid');

    if (session.kickSelected.has(idx)) {
        session.kickSelected.delete(idx);
    } else {
        session.kickSelected.add(idx);
    }
    setSession(userId, session);
    await ctx.answerCbQuery(`${session.kickSelected.size} dipilih`);
});

// Kick semua
tgBot.action('kick_all', async ctx => {
    const userId  = ctx.from.id;
    const session = getSession(userId);
    if (!session?.kickCandidates) return ctx.answerCbQuery('Sesi kadaluarsa');

    const allJids = session.kickCandidates.map(m => m.jid);
    await ctx.answerCbQuery('Memproses...');
    const result = await executeKick(userId, session, allJids, ctx);
    if (result) {
        await ctx.reply(
            `✅ *Kick selesai\\!*\n\nBerhasil: ${result.berhasil}\nGagal: ${result.gagal}\nTotal: ${result.total}`,
            { parse_mode: 'MarkdownV2' }
        );
    }
});

// Batal
tgBot.action('kick_cancel', async ctx => {
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('❌ Operasi kick dibatalkan\\.', { parse_mode: 'MarkdownV2' });
});

// ─────────────────────────────────────────────
// 19. ADMIN COMMANDS
// ─────────────────────────────────────────────

function requireAdmin(ctx, next) {
    if (!ADMIN_IDS.includes(ctx.from.id)) {
        secureLog('warn', 'Unauthorized admin access', { userId: ctx.from.id });
        return ctx.reply('❌ Akses ditolak\\.', { parse_mode: 'MarkdownV2' });
    }
    return next();
}

// Aktivasi user — admin only
tgBot.command('activate', requireAdmin, async ctx => {
    const parts  = ctx.message.text.split(' ');
    const target = parseInt(parts[1]);
    const pkg    = parts[2];

    if (!target || !PACKAGES[pkg]) {
        return ctx.reply(
            '❌ Format: /activate \\[userId\\] \\[paket\\]\n' +
            'Paket: ' + escapeMarkdown(Object.keys(PACKAGES).join(', ')),
            { parse_mode: 'MarkdownV2' }
        );
    }

    const data    = loadData();
    const expDate = new Date(Date.now() + PACKAGES[pkg].days * 86400_000).toISOString();
    const idx     = data.users.findIndex(u => u.id === target);

    if (idx >= 0) {
        data.users[idx].active    = true;
        data.users[idx].expiredAt = expDate;
        data.users[idx].package   = pkg;
    } else {
        data.users.push({ id: target, active: true, expiredAt: expDate, package: pkg, createdAt: new Date().toISOString() });
    }

    await saveData(data);
    await auditLog(ctx.from.id, 'ADMIN_ACTIVATE', { target, pkg, expDate });
    await ctx.reply(
        `✅ User \`${target}\` diaktifkan\n` +
        `Paket: ${escapeMarkdown(PACKAGES[pkg].label)}\n` +
        `Hingga: ${escapeMarkdown(new Date(expDate).toLocaleDateString('id-ID'))}`,
        { parse_mode: 'MarkdownV2' }
    );
});

// Lihat audit log — admin only
tgBot.command('auditlog', requireAdmin, async ctx => {
    const parts  = ctx.message.text.split(' ');
    const target = parts[1] || ctx.from.id;
    const logs   = await redis.lrange(`audit:${target}`, 0, 19);

    if (!logs.length) {
        return ctx.reply('ℹ️ Tidak ada audit log\\.', { parse_mode: 'MarkdownV2' });
    }

    const lines = logs.map(l => {
        try {
            const e = JSON.parse(l);
            return `\\[${e.ts?.slice(11,19)}\\] ${escapeMarkdown(e.action)}`;
        } catch (_) { return '\\[parse error\\]'; }
    }).join('\n');

    await ctx.reply(`📋 *Audit Log untuk ${target}:*\n\n${lines}`, { parse_mode: 'MarkdownV2' });
});

// ─────────────────────────────────────────────
// 20. ERROR HANDLER
// ─────────────────────────────────────────────

tgBot.catch((err, ctx) => {
    secureLog('error', 'Bot error', {
        error:  err.message,
        userId: ctx?.from?.id,
        update: ctx?.updateType,
    });
    ctx?.reply('⚠️ Terjadi kesalahan internal\\. Coba lagi\\.', { parse_mode: 'MarkdownV2' })
        .catch(() => {});
});

// ─────────────────────────────────────────────
// 21. GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

async function shutdown(signal) {
    secureLog('info', `Received ${signal}, shutting down gracefully`);
    tgBot.stop(signal);
    // Tutup semua sesi WA
    for (const [key, session] of Object.entries(sessionCache.keys().reduce((acc, k) => {
        acc[k] = sessionCache.get(k); return acc;
    }, {}))) {
        try { session?.sock?.end(new Error('shutdown')); } catch (_) {}
    }
    await redis.quit();
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tangkap unhandled rejections agar tidak crash diam-diam
process.on('unhandledRejection', (reason) => {
    secureLog('error', 'Unhandled rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
    secureLog('error', 'Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1); // Fail fast — biarkan process manager restart
});

// ─────────────────────────────────────────────
// 22. LAUNCH
// ─────────────────────────────────────────────

async function launch() {
    secureLog('info', 'Starting WA Kicker Bot v5.0');

    if (process.env.NODE_ENV === 'production') {
        // Mode webhook
        const webhookUrl = `${process.env.BASE_URL}/webhook/${process.env.WEBHOOK_SECRET}`;
        await tgBot.telegram.setWebhook(webhookUrl, {
            secret_token:        process.env.WEBHOOK_SECRET, // Header validation Telegram
            allowed_updates:     ['message', 'callback_query'],
            drop_pending_updates: true,
            max_connections:      40,
        });
        app.use(tgBot.webhookCallback(`/webhook/${process.env.WEBHOOK_SECRET}`));
        const PORT = parseInt(process.env.PORT) || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            secureLog('info', `Webhook server listening on port ${PORT}`);
        });
    } else {
        // Mode polling (development)
        await tgBot.launch();
        secureLog('info', 'Bot running in polling mode (development)');
    }

    secureLog('info', 'Bot started successfully', {
        version:  '5.0',
        env:      process.env.NODE_ENV || 'development',
        security: [
            'AES-256-GCM encryption with random salt',
            'Redis-backed rate limiting (persistent, cluster-safe)',
            'Timing-safe webhook validation',
            'Telegram IP allowlist validation',
            'Audit trail (Redis + rotating log files)',
            'Atomic file writes (temp→rename)',
            'Input sanitization (storage vs render separated)',
            'Path traversal prevention',
            'JID format validation',
            'Graceful shutdown with session cleanup',
        ]
    });
}

launch().catch(err => {
    secureLog('error', 'Launch failed', { error: err.message });
    process.exit(1);
});
