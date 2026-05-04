const { Telegraf, Markup } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════╗
// ║              W A  K I C K E R  B O T  v2.0                  ║
// ║         Bot WA Kick Berbayar dengan Sistem Trial             ║
// ╚══════════════════════════════════════════════════════════════╝

// ──────────────────────────────────────────────────────────────
//  KONFIGURASI UTAMA
// ──────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = 'ISI_TOKEN_BOT_TELEGRAM_LO_DISINI';

// Admin IDs — bisa lebih dari satu
// Cek ID lo: chat ke @userinfobot di Telegram
const ADMIN_IDS = [
    123456789,   // ← ganti dengan ID Telegram lo
    // 987654321 // ← tambah admin lain kalau perlu
];

// Nama & info kontak untuk notifikasi pembayaran
const BOT_NAME        = '⚡ WA Kicker Bot';
const PAYMENT_INFO    = 'Transfer ke:\n🏦 BCA: 1234567890 a/n Bot Owner\n💚 GoPay/OVO: 081234567890';
const PAYMENT_CONTACT = '@adminusername'; // username Telegram admin untuk konfirmasi bayar

// Durasi trial (dalam jam)
const TRIAL_DURATION_HOURS = 24;

// Harga paket (dalam Rupiah)
const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: 50000  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: 125000 },
    '6bulan':  { label: '6 Bulan',  days: 180, price: 200000 },
    '1tahun':  { label: '1 Tahun',  days: 365, price: 350000 },
};

// File penyimpanan data
const DATA_FILE        = './bot_users.json';
const AUTH_BASE_FOLDER = './auth_states';

// ──────────────────────────────────────────────────────────────

const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions = new Map();
const kickSelections = new Map();

if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER);

// ══════════════════════════════════════════════════════════════
//  MANAJEMEN DATA USER
// ══════════════════════════════════════════════════════════════

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const init = { admins: [], users: [], pending: [], pendingPayment: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!raw.users && raw.approved) {
            raw.users = raw.approved.map(u => ({
                ...u,
                role: 'regular',
                expiresAt: null,
                hadTrial: true
            }));
            delete raw.approved;
        }
        raw.users          = raw.users          || [];
        raw.pending        = raw.pending        || [];
        raw.pendingPayment = raw.pendingPayment || [];
        return raw;
    } catch {
        return { users: [], pending: [], pendingPayment: [] };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── ROLE CHECKS ──────────────────────────────────────────────

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function getUser(userId) {
    if (isAdmin(userId)) return { id: userId, role: 'admin', status: 'active' };
    const data = loadData();
    return (data.users || []).find(u => u.id === userId) || null;
}

function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') {
        const exp = new Date(u.expiresAt);
        if (exp > new Date()) return 'regular';
        return 'expired';
    }
    if (u.role === 'trial') {
        const exp = new Date(u.trialExpiresAt);
        if (exp > new Date()) return 'trial';
        return 'trial_expired';
    }
    return 'none';
}

function canUseBot(userId) {
    const s = getUserStatus(userId);
    return ['admin', 'regular', 'trial'].includes(s);
}

function isTrialOnly(userId) {
    return getUserStatus(userId) === 'trial';
}

// ── TRIAL ────────────────────────────────────────────────────

function startTrial(user) {
    const data = loadData();
    const existing = data.users.find(u => u.id === user.id);
    if (existing) return { success: false, reason: 'already_user', user: existing };
    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) return { success: false, reason: 'used_trial' };
    const now = new Date();
    const exp = new Date(now.getTime() + TRIAL_DURATION_HOURS * 60 * 60 * 1000);
    const newUser = {
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        role: 'trial',
        trialStartedAt: now.toISOString(),
        trialExpiresAt: exp.toISOString(),
        hadTrial: true,
        createdAt: now.toISOString()
    };
    data.users.push(newUser);
    saveData(data);
    return { success: true, user: newUser, expiresAt: exp };
}

// ── PENDING PAYMENT ──────────────────────────────────────────

function addPendingPayment(user, packageKey) {
    const data = loadData();
    data.pendingPayment = data.pendingPayment.filter(p => p.id !== user.id);
    data.pendingPayment.push({
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        packageKey,
        requestedAt: new Date().toISOString()
    });
    saveData(data);
}

function getPendingPayment(userId) {
    const data = loadData();
    return data.pendingPayment.find(p => p.id === userId) || null;
}

// ── APPROVE PAYMENT ──────────────────────────────────────────

function approvePayment(userId, packageKey) {
    const data = loadData();
    const pkg = PACKAGES[packageKey];
    if (!pkg) return { success: false, reason: 'invalid_package' };
    const pendIdx = data.pendingPayment.findIndex(p => p.id === userId);
    let userInfo = pendIdx >= 0 ? data.pendingPayment.splice(pendIdx, 1)[0] : null;
    const now = new Date();
    let expiresAt;
    const existingIdx = data.users.findIndex(u => u.id === userId);
    if (existingIdx >= 0) {
        const existing = data.users[existingIdx];
        const base = existing.expiresAt && new Date(existing.expiresAt) > now
            ? new Date(existing.expiresAt)
            : now;
        expiresAt = new Date(base.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        data.users[existingIdx] = {
            ...existing,
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            updatedAt: now.toISOString()
        };
    } else {
        expiresAt = new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        const infoSource = userInfo || {};
        data.users.push({
            id: userId,
            username: infoSource.username || null,
            firstName: infoSource.firstName || '',
            lastName: infoSource.lastName || '',
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            hadTrial: true,
            createdAt: now.toISOString()
        });
    }
    saveData(data);
    return { success: true, expiresAt, pkg };
}

// ── REVOKE USER ──────────────────────────────────────────────

function revokeUser(userId) {
    const data = loadData();
    const idx = data.users.findIndex(u => u.id === userId);
    if (idx === -1) return null;
    const [user] = data.users.splice(idx, 1);
    saveData(data);
    return user;
}

function getAllPendingPayments() {
    return loadData().pendingPayment || [];
}

function getAllUsers() {
    return loadData().users || [];
}

// ══════════════════════════════════════════════════════════════
//  FORMATTING HELPERS
// ══════════════════════════════════════════════════════════════

function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function formatCountdown(isoStr) {
    const ms = new Date(isoStr) - new Date();
    if (ms <= 0) return 'SUDAH EXPIRED';
    const hours = Math.floor(ms / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} hari ${hours % 24} jam`;
    }
    return `${hours} jam ${mins} menit`;
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function userDisplayName(u) {
    const name  = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama';
    const uname = u.username ? ` (@${u.username})` : '';
    return `${name}${uname}`;
}

function userDisplayNameEsc(u) {
    const name  = esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama');
    const uname = u.username ? ` (@${esc(u.username)})` : '';
    return `${name}${uname}`;
}

// ── BANNER TEKS ──────────────────────────────────────────────

const DIVIDER      = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ══════════════════════════════════════════════════════════════
//  REPLY KEYBOARDS
// ══════════════════════════════════════════════════════════════

// Keyboard landing — user baru belum punya akses
const KB_LANDING = Markup.keyboard([
    ['🎁 Coba Gratis (Trial)', '⭐ Premium'],
    ['❓ Bantuan'],
]).resize();

// Keyboard SEBELUM login — sudah punya akses tapi belum login WA
const KB_PRE_LOGIN = Markup.keyboard([
    ['🔑 Login WhatsApp'],
    ['📊 Status', '👤 Akun Saya'],
    ['⭐ Premium', '❓ Bantuan'],
]).resize();

// Keyboard SETELAH login — menu utama WA (user trial/reguler)
const KB_MAIN = Markup.keyboard([
    ['📋 Daftar Grup', '🎯 Pilih Grup'],
    ['➕ Buat Grup WA', '📥 Import VCF'],
    ['🔴 Kick Menu', '📡 Status'],
    ['🚪 Logout WhatsApp'],
]).resize();

// Keyboard ADMIN sebelum login
const KB_ADMIN_PRE = Markup.keyboard([
    ['🔑 Login WhatsApp'],
    ['📋 Pending Payment', '👥 User List'],
    ['📊 Status', '❓ Bantuan'],
]).resize();

// Keyboard ADMIN setelah login
const KB_ADMIN_MAIN = Markup.keyboard([
    ['📋 Daftar Grup', '🎯 Pilih Grup'],
    ['➕ Buat Grup WA', '📥 Import VCF'],
    ['🔴 Kick Menu', '📡 Status'],
    ['📋 Pending Payment', '👥 User List'],
    ['🚪 Logout WhatsApp'],
]).resize();

// Helper: kirim keyboard yang tepat berdasarkan status & login
function getKeyboard(userId) {
    const loggedIn = userSessions.get(userId)?.loggedIn;
    if (isAdmin(userId)) return loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return loggedIn ? KB_MAIN : KB_PRE_LOGIN;
    return KB_LANDING;
}

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE: CEK AKSES
// ══════════════════════════════════════════════════════════════

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();
    if (status === 'expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Paket lo sudah expired.\nPerpanjang sekarang!\n\n` +
            `Ketuk *⭐ Premium* atau ketik /beli`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    if (status === 'trial_expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Masa trial lo sudah habis.\nUpgrade ke paket reguler!\n\n` +
            `Ketuk *⭐ Premium* atau ketik /beli`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    await ctx.reply(
        `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\n` +
        `🎁 Coba *gratis ${TRIAL_DURATION_HOURS} jam* — tekan tombol di bawah\n` +
        `⭐ Atau langsung beli paket Premium`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
}

// ══════════════════════════════════════════════════════════════
//  HELPERS WA
// ══════════════════════════════════════════════════════════════

async function sendQR(ctx, qr) {
    try {
        const qrBuffer = await QRCode.toBuffer(qr, {
            type: 'png', width: 512, margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption:
                `📱 *Scan QR Code di WhatsApp*\n\n` +
                `${DIVIDER_THIN}\n` +
                `Cara scan:\n` +
                `1. Buka WhatsApp\n` +
                `2. Ketuk ⋮ (titik tiga) → *Perangkat Tertaut*\n` +
                `3. Ketuk *Tautkan Perangkat*\n` +
                `4. Scan QR di atas\n` +
                `${DIVIDER_THIN}\n\n` +
                `⏱ QR berlaku *5 menit*\nQR expired? Ketik /refreshqr`,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        await ctx.reply(`❌ *Gagal kirim QR:* ${err.message}`, { parse_mode: 'Markdown' });
    }
}

function buildMemberKeyboard(members, selected) {
    const buttons = members.map(m => {
        const isSelected = selected.has(m.jid);
        const label = isSelected ? `✅ ${m.name}` : `○ ${m.name}`;
        return [Markup.button.callback(label, `toggle_${m.jid}`)];
    });
    buttons.push([
        Markup.button.callback(`🔴 Kick Terpilih (${selected.size} orang)`, 'do_kick'),
        Markup.button.callback('✖ Batal', 'cancel_kick')
    ]);
    return Markup.inlineKeyboard(buttons);
}

async function startLogin(ctx, userId) {
    if (userSessions.has(userId)) {
        const old = userSessions.get(userId);
        if (old.qrTimer) clearTimeout(old.qrTimer);
        try { old.sock.end(new Error('restart')); } catch (_) {}
        userSessions.delete(userId);
    }
    const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' })
    });
    const session = {
        sock, saveCreds,
        qrTimer: null, lastQR: null, qrBlocked: false,
        loggedIn: false, groupId: null, groupName: null, members: []
    };
    userSessions.set(userId, session);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            session.lastQR = qr;
            if (!session.qrBlocked) {
                session.qrBlocked = true;
                await sendQR(ctx, qr);
                session.qrTimer = setTimeout(async () => {
                    if (!session.loggedIn) {
                        session.qrBlocked = false;
                        await ctx.reply(`⏱ *QR sudah expired.*\nKetik /refreshqr untuk QR baru.`, { parse_mode: 'Markdown' });
                    }
                }, 5 * 60 * 1000);
            }
        }
        if (connection === 'close') {
            if (session.qrTimer) clearTimeout(session.qrTimer);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (!session.loggedIn) {
                const msg = statusCode === DisconnectReason.loggedOut
                    ? '🚫 *Session ditolak WA.* Ketik /login untuk coba lagi.'
                    : '🔌 *Koneksi terputus.* Ketik /login untuk coba lagi.';
                await ctx.reply(msg);
                userSessions.delete(userId);
            } else {
                await ctx.reply('⚠️ *Koneksi WA terputus.*\nKetik /login untuk reconnect.', { parse_mode: 'Markdown' });
                userSessions.delete(userId);
            }
        }
        if (connection === 'open') {
            session.loggedIn = true;
            if (session.qrTimer) clearTimeout(session.qrTimer);
            await ctx.reply(
                `✅ *LOGIN WHATSAPP BERHASIL!*\n\n` +
                `${DIVIDER_THIN}\n` +
                `Pilih menu di keyboard bawah:\n\n` +
                `📋 *Daftar Grup* — lihat semua grup WA\n` +
                `🎯 *Pilih Grup* — tentukan target grup\n` +
                `➕ *Buat Grup WA* — buat grup baru\n` +
                `🔴 *Kick Menu* — kick anggota\n` +
                `📥 *Import VCF* — import kontak\n` +
                `${DIVIDER_THIN}`,
                { parse_mode: 'Markdown', ...getKeyboard(userId) }
            );
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// ══════════════════════════════════════════════════════════════
//  /START — HALAMAN UTAMA
// ══════════════════════════════════════════════════════════════

tgBot.start(async (ctx) => {
    const userId   = ctx.from.id;
    const name     = ctx.from.first_name || 'User';
    const status   = getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;

    // ── ADMIN ─────────────────────────────────────────────────
    if (isAdmin(userId)) {
        const kb = loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `👑 *Selamat datang, Admin ${name}!*\n\n${DIVIDER_THIN}\n` +
            (loggedIn
                ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`) +
            `\n${DIVIDER_THIN}`,
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── REGULAR AKTIF ─────────────────────────────────────────
    if (status === 'regular') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `✅ *Halo ${name}!*\n\n${DIVIDER_THIN}\n` +
            `🏷️ Status: *Premium Aktif*\n` +
            `📅 Hingga: *${formatDate(u.expiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.expiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn
                ? `📡 WA: *Terhubung* ✅\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── TRIAL AKTIF ───────────────────────────────────────────
    if (status === 'trial') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `🎁 *Halo ${name}!*\n\n${DIVIDER_THIN}\n` +
            `🏷️ Status: *Trial Aktif*\n` +
            `⏱ Habis: *${formatDate(u.trialExpiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.trialExpiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn
                ? `📡 WA: *Terhubung* ✅\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`) +
            `\n\n_Trial hanya 1 grup WA. Upgrade: ketuk ⭐ Premium_`,
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── EXPIRED ───────────────────────────────────────────────
    if (status === 'expired' || status === 'trial_expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `⚠️ *Halo ${name}!*\n\nAkses lo sudah berakhir.\nPerpanjang untuk bisa pakai lagi!`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    // ── USER BARU ─────────────────────────────────────────────
    await ctx.reply(
        `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
        `👋 *Halo ${name}!*\n\n` +
        `Bot ini membantu lo *kick anggota grup WhatsApp* dengan mudah langsung dari Telegram.\n\n` +
        `${DIVIDER_THIN}\n` +
        `🎁 *COBA GRATIS ${TRIAL_DURATION_HOURS} JAM* — tanpa bayar\n` +
        `⭐ *PREMIUM* — akses penuh tanpa batas\n` +
        `${DIVIDER_THIN}\n\n` +
        `Pilih di bawah untuk memulai:`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
});

// ══════════════════════════════════════════════════════════════
//  HANDLER TOMBOL REPLY KEYBOARD — USER
// ══════════════════════════════════════════════════════════════

// ── 🎁 Coba Gratis (Trial) ────────────────────────────────────
tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);
    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin, tidak perlu trial.');
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler aktif.');
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ *Lo masih dalam masa trial.*\n\nSisa: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown' });
    }
    const data     = loadData();
    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) {
        return ctx.reply(
            `❌ *Lo sudah pernah menggunakan masa trial.*\n\n` +
            `Upgrade ke paket reguler untuk akses penuh.\n` +
            `Ketuk *⭐ Premium* untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ Gagal memulai trial: ${result.reason}`);
    await ctx.reply(
        `🎉 *TRIAL BERHASIL DIAKTIFKAN!*\n\n${DIVIDER_THIN}\n` +
        `✅ Akses trial aktif selama *${TRIAL_DURATION_HOURS} jam*\n` +
        `⏱ Berakhir: *${formatDate(result.expiresAt.toISOString())}*\n` +
        `${DIVIDER_THIN}\n\n` +
        `*Batasan trial:*\n• Hanya bisa akses *1 grup WA*\n• Durasi *${TRIAL_DURATION_HOURS} jam*\n\n` +
        `*Mulai pakai:*\nTekan *🔑 Login WhatsApp* di bawah!\n\n` +
        `⭐ Upgrade kapan saja: ketuk tombol Premium`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

// ── ⭐ Premium ────────────────────────────────────────────────
tgBot.hears('⭐ Premium', async (ctx) => {
    const status    = getUserStatus(ctx.from.id);
    const isRenewal = status === 'regular';
    const keyboard  = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)} (hemat 17%)`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)} (hemat 33%)`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)} (hemat 42%)`, 'buy_1tahun')],
    ]);
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PAKET PREMIUM\n╚${DIVIDER}╝\n\n` +
        `${isRenewal ? '🔄 *Perpanjang akses lo!*' : '⭐ *Pilih paket yang sesuai:*'}\n\n` +
        `${DIVIDER_THIN}\n` +
        `📦 *1 Bulan*  → ${formatRupiah(PACKAGES['1bulan'].price)}\n` +
        `📦 *3 Bulan*  → ${formatRupiah(PACKAGES['3bulan'].price)}  *(hemat 17%)*\n` +
        `📦 *6 Bulan*  → ${formatRupiah(PACKAGES['6bulan'].price)}  *(hemat 33%)*\n` +
        `🏆 *1 Tahun*  → ${formatRupiah(PACKAGES['1tahun'].price)}  *(hemat 42%)*\n` +
        `${DIVIDER_THIN}\n\n` +
        `✅ *Semua paket Premium:*\n` +
        `• Akses grup WA *tidak terbatas*\n` +
        `• Kick anggota tanpa batasan\n` +
        `• Prioritas support\n\nPilih paket di bawah:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
});

// ── ❓ Bantuan ────────────────────────────────────────────────
tgBot.hears('❓ Bantuan', async (ctx) => {
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PANDUAN PENGGUNAAN\n╚${DIVIDER}╝\n\n` +
        `${DIVIDER_THIN}\n*📌 CARA PAKAI BOT:*\n${DIVIDER_THIN}\n\n` +
        `*1. Daftar & Aktifkan Akses*\n` +
        `   🎁 Coba Gratis (Trial) — trial ${TRIAL_DURATION_HOURS} jam\n` +
        `   ⭐ Premium — beli paket reguler\n\n` +
        `*2. Login WhatsApp*\n` +
        `   🔑 Login WhatsApp — mulai koneksi\n` +
        `   → Scan QR di WA lo\n\n` +
        `*3. Pilih Grup*\n` +
        `   📋 Daftar Grup — lihat semua grup\n` +
        `   🎯 Pilih Grup — pilih target (/select "Nama")\n\n` +
        `*4. Kick Anggota*\n` +
        `   🔴 Kick Menu — tampilkan & pilih anggota\n` +
        `   → Centang → Tekan Kick\n\n` +
        `*5. Buat Grup & Import Kontak*\n` +
        `   ➕ Buat Grup WA — buat grup baru\n` +
        `   📥 Import VCF — tambah kontak dari file\n\n` +
        `${DIVIDER_THIN}\n*⚠️ PENTING:*\n` +
        `• Bot hanya bisa kick jika lo adalah *admin grup*\n` +
        `• Akun WA yang login harus jadi *admin* di grup target\n` +
        `• Trial hanya bisa akses *1 grup*\n` +
        `${DIVIDER_THIN}\n\nButuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

// ── 🔑 Login WhatsApp ─────────────────────────────────────────
tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply(
            '✅ *Lo udah login ke WhatsApp!*\nGunakan 🚪 Logout WhatsApp dulu jika ingin ganti akun.',
            { parse_mode: 'Markdown', ...getKeyboard(userId) }
        );
    }
    await ctx.reply(
        `🔄 *Memulai koneksi ke WhatsApp...*\n\n_Harap tunggu, QR code akan segera muncul..._`,
        { parse_mode: 'Markdown' }
    );
    try { await startLogin(ctx, userId); } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ── 📋 Daftar Grup ────────────────────────────────────────────
tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    }
    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ *Tidak ada grup WA.*', { parse_mode: 'Markdown' });
        const isTrial      = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP WA\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ _Trial: hanya 1 grup ditampilkan_\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `*${i + 1}.* ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        if (isTrial && groups.length > 1) msg += `_+${groups.length - 1} grup lain (upgrade untuk akses semua)_\n\n`;
        msg += `${DIVIDER_THIN}\nKetik: /select "Nama Grup" — untuk pilih grup target`;
        await ctx.reply(msg);
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ── 🎯 Pilih Grup ─────────────────────────────────────────────
tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    }
    await ctx.reply(
        `🎯 *Pilih Grup Target*\n\n` +
        `Ketik perintah berikut:\n` +
        `/select "Nama Grup"\n\n` +
        `Contoh:\n` +
        `/select "Arisan RT 05"\n` +
        `/select "Tim Sales Jakarta"\n\n` +
        `_Lihat daftar grup dulu di 📋 Daftar Grup_`,
        { parse_mode: 'Markdown' }
    );
});

// ── ➕ Buat Grup WA ───────────────────────────────────────────
tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    }
    await ctx.reply(
        `╔${DIVIDER}╗\n║  BUAT GRUP WA BARU\n╚${DIVIDER}╝\n\n` +
        `Ketik perintah berikut:\n` +
        `/buatgrup "Nama Grup"\n\n` +
        `Contoh:\n` +
        `/buatgrup "Arisan RT 05"\n` +
        `/buatgrup "Tim Sales Jakarta"`,
        { parse_mode: 'Markdown' }
    );
});

// ── 📥 Import VCF ────────────────────────────────────────────
tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    }
    if (!session.groupId) {
        return ctx.reply(
            `❌ *Pilih grup dulu!*\n\n` +
            `Gunakan 🎯 Pilih Grup atau\n/select "Nama Grup"`,
            { parse_mode: 'Markdown' }
        );
    }
    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n` +
        `${DIVIDER_THIN}\n📎 *Kirim file .vcf sekarang*\n\n` +
        `File VCF yang didukung:\n` +
        `• vCard 2.1, 3.0, 4.0\n` +
        `• Nomor lokal 08xx → otomatis 628xx\n` +
        `• Nomor internasional +628xx\n` +
        `• Multi-nomor per kontak\n` +
        `• Nama dengan emoji/CJK/Arab ✓\n` +
        `${DIVIDER_THIN}\n\n_Kirim file .vcf langsung ke chat ini..._`,
        { parse_mode: 'Markdown' }
    );
});

// ── 🔴 Kick Menu ─────────────────────────────────────────────
tgBot.hears('🔴 Kick Menu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    }
    if (!session.groupId) {
        return ctx.reply(
            `❌ *Pilih grup dulu!*\n\n` +
            `Gunakan 🎯 Pilih Grup atau\n/select "Nama Grup"`,
            { parse_mode: 'Markdown' }
        );
    }
    await ctx.reply('⏳ *Mengambil daftar anggota...*', { parse_mode: 'Markdown' });
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const members  = metadata.participants
            .filter(p => {
                const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));
        if (members.length === 0) {
            return ctx.reply(`ℹ️ *Tidak ada anggota yang bisa dikick.*\n\nSemua anggota adalah admin.`, { parse_mode: 'Markdown' });
        }
        session.members = members;
        kickSelections.set(userId, new Set());
        const keyboard = buildMemberKeyboard(members, kickSelections.get(userId));
        await ctx.reply(
            `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n` +
            `🎯 Grup: *${session.groupName}*\n` +
            `👥 Non-admin: *${members.length} orang*\n\n` +
            `Ketuk nama untuk pilih/batal.\n` +
            `Tekan *Kick Terpilih* jika sudah siap.\n\n` +
            `⚠️ _Aksi kick tidak bisa dibatalkan!_`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ── 📡 Status / 📊 Status ─────────────────────────────────────
async function handleStatus(ctx) {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR Scan';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin')   accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `✅ Reguler (exp: ${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (sisa: ${formatCountdown(u?.trialExpiresAt)})`;
    await ctx.reply(
        `╔${DIVIDER}╗\n║  STATUS\n╚${DIVIDER}╝\n\n` +
        `📡 *WA:* ${waStatus}\n` +
        `🏷️ *Akun:* ${accLine}\n` +
        (session?.groupName ? `🎯 *Grup aktif:* ${session.groupName}\n` : '🎯 *Grup:* Belum dipilih\n'),
        { parse_mode: 'Markdown' }
    );
}
tgBot.hears('📡 Status', requireAccess, handleStatus);
tgBot.hears('📊 Status', handleStatus);

// ── 👤 Akun Saya ─────────────────────────────────────────────
tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') {
        return ctx.reply(`👑 *Lo adalah Admin bot ini.*\n\nAkses penuh tanpa batas.`, { parse_mode: 'Markdown' });
    }
    const u = getUser(userId);
    if (!u) {
        return ctx.reply(
            `📋 *Info Akun Lo*\n\nStatus: *Belum terdaftar*\n\n` +
            `Ketuk 🎁 Coba Gratis untuk trial.\nKetuk ⭐ Premium untuk beli akses.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    let statusLine = '';
    if (status === 'regular')      statusLine = `✅ *Reguler* (Aktif)`;
    else if (status === 'trial')   statusLine = `🎁 *Trial* (Aktif)`;
    else if (status === 'expired') statusLine = `❌ *Reguler* (Expired)`;
    else if (status === 'trial_expired') statusLine = `❌ *Trial* (Expired)`;
    const expDate = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
    const sisa    = expDate && new Date(expDate) > new Date() ? formatCountdown(expDate) : 'Expired';
    await ctx.reply(
        `╔${DIVIDER}╗\n║  INFO AKUN\n╚${DIVIDER}╝\n\n` +
        `👤 Nama: ${userDisplayNameEsc(u)}\n🆔 *ID:* \`${u.id}\`\n\n` +
        `${DIVIDER_THIN}\n` +
        `🏷️ *Status:* ${statusLine}\n` +
        (expDate ? `📅 *Expires:* ${formatDate(expDate)}\n` : '') +
        (sisa !== 'Expired' ? `⏳ *Sisa:* ${sisa}\n` : '') +
        `${DIVIDER_THIN}\n\n` +
        (status === 'expired' || status === 'trial_expired'
            ? `⚠️ Akses lo sudah habis!\nKetuk ⭐ Premium untuk perpanjang.`
            : `⭐ Perpanjang / upgrade: ketuk tombol Premium`),
        { parse_mode: 'Markdown' }
    );
});

// ── 🚪 Logout WhatsApp ────────────────────────────────────────
tgBot.hears('🚪 Logout WhatsApp', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) {
        return ctx.reply('❌ Lo belum login!', { parse_mode: 'Markdown' });
    }
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout WhatsApp berhasil.*\n\nTekan 🔑 Login WhatsApp untuk login ulang.', {
            parse_mode: 'Markdown',
            ...getKeyboard(userId)
        });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

// ══════════════════════════════════════════════════════════════
//  HANDLER TOMBOL REPLY KEYBOARD — ADMIN
// ══════════════════════════════════════════════════════════════

// ── 📋 Pending Payment ────────────────────────────────────────
tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 *Tidak ada pembayaran pending.*`, { parse_mode: 'Markdown' });
    let msg = `╔${DIVIDER}╗\n║  PEMBAYARAN PENDING\n╚${DIVIDER}╝\n\nTotal: ${list.length} permintaan\n\n`;
    list.forEach((p, i) => {
        const pkg = PACKAGES[p.packageKey];
        msg += `${i + 1}. ${userDisplayName(p)}\n`;
        msg += `   ID: ${p.id}\n`;
        msg += `   Paket: ${pkg ? pkg.label : p.packageKey} (${pkg ? formatRupiah(pkg.price) : '-'})\n`;
        msg += `   Waktu: ${formatDate(p.requestedAt)}\n\n`;
    });
    msg += `${DIVIDER_THIN}\n`;
    msg += `Approve: /approvepayment [id] [paket]\n`;
    msg += `Reject: /rejectpayment [id]\n`;
    msg += `Paket: 1bulan / 3bulan / 6bulan / 1tahun`;
    await ctx.reply(msg);
});

// ── 👥 User List ─────────────────────────────────────────────
tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > new Date();
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= new Date();
    });
    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n`;
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;
    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n`;
            msg += `   ID: ${u.id} | ${role}\n`;
            msg += `   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }
    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: ${u.id}\n`;
            msg += `   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n(+${expired.length} user expired tidak ditampilkan)`;
    }
    msg += `\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg);
});

// ══════════════════════════════════════════════════════════════
//  COMMANDS SLASH — USER
// ══════════════════════════════════════════════════════════════

tgBot.command('trial', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);
    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin, tidak perlu trial.');
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler aktif.');
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ *Lo masih dalam masa trial.*\n\nSisa: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown' });
    }
    const data     = loadData();
    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) {
        return ctx.reply(
            `❌ *Lo sudah pernah menggunakan masa trial.*\n\n` +
            `Upgrade ke paket reguler untuk akses penuh.\n` +
            `Ketuk ⭐ Premium untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ Gagal memulai trial: ${result.reason}`);
    await ctx.reply(
        `🎉 *TRIAL BERHASIL DIAKTIFKAN!*\n\n${DIVIDER_THIN}\n` +
        `✅ Akses trial aktif selama *${TRIAL_DURATION_HOURS} jam*\n` +
        `⏱ Berakhir: *${formatDate(result.expiresAt.toISOString())}*\n` +
        `${DIVIDER_THIN}\n\n` +
        `*Batasan trial:*\n• Hanya bisa akses *1 grup WA*\n• Durasi *${TRIAL_DURATION_HOURS} jam*\n\n` +
        `*Mulai pakai:*\nTekan *🔑 Login WhatsApp* di bawah!\n\n` +
        `⭐ Upgrade kapan saja: ketuk tombol Premium`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

tgBot.command('beli', async (ctx) => {
    const status    = getUserStatus(ctx.from.id);
    const isRenewal = status === 'regular';
    const keyboard  = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)} (hemat 17%)`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)} (hemat 33%)`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)} (hemat 42%)`, 'buy_1tahun')],
    ]);
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PAKET PREMIUM\n╚${DIVIDER}╝\n\n` +
        `${isRenewal ? '🔄 *Perpanjang akses lo!*' : '⭐ *Pilih paket yang sesuai:*'}\n\n` +
        `${DIVIDER_THIN}\n` +
        `📦 *1 Bulan*  → ${formatRupiah(PACKAGES['1bulan'].price)}\n` +
        `📦 *3 Bulan*  → ${formatRupiah(PACKAGES['3bulan'].price)}  *(hemat 17%)*\n` +
        `📦 *6 Bulan*  → ${formatRupiah(PACKAGES['6bulan'].price)}  *(hemat 33%)*\n` +
        `🏆 *1 Tahun*  → ${formatRupiah(PACKAGES['1tahun'].price)}  *(hemat 42%)*\n` +
        `${DIVIDER_THIN}\n\n` +
        `✅ *Semua paket Premium:*\n• Akses grup WA *tidak terbatas*\n• Kick anggota tanpa batasan\n• Prioritas support\n\nPilih paket di bawah:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
});

// Callback tombol paket
Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        const pkg  = PACKAGES[pkgKey];
        const user = ctx.from;
        addPendingPayment(user, pkgKey);
        for (const adminId of ADMIN_IDS) {
            try {
                await tgBot.telegram.sendMessage(
                    adminId,
                    `🔔 PERMINTAAN BELI BARU\n\n` +
                    `👤 ${userDisplayName(user)}\n` +
                    `ID: ${user.id}\n` +
                    `Paket: ${pkg.label} (${formatRupiah(pkg.price)})\n` +
                    `Waktu: ${formatDate(new Date().toISOString())}\n\n` +
                    `Approve: /approvepayment ${user.id} ${pkgKey}\n` +
                    `Reject: /rejectpayment ${user.id}`
                );
            } catch (_) {}
        }
        await ctx.reply(
            `✅ *Permintaan pembelian diterima!*\n\n${DIVIDER_THIN}\n` +
            `📦 Paket: *${pkg.label}*\n` +
            `💰 Harga: *${formatRupiah(pkg.price)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            `*Langkah selanjutnya:*\n\n` +
            `1️⃣ *Lakukan pembayaran:*\n${PAYMENT_INFO}\n\n` +
            `2️⃣ *Konfirmasi ke admin:*\n` +
            `Kirim bukti transfer ke ${PAYMENT_CONTACT}\n` +
            `dengan format: \`KICKER-${user.id}-${pkgKey}\`\n\n` +
            `3️⃣ Admin akan memverifikasi & mengaktifkan akses lo.\n\n` +
            `${DIVIDER_THIN}\nℹ️ Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
            { parse_mode: 'Markdown' }
        );
    });
});

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') return ctx.reply(`👑 *Lo adalah Admin bot ini.*\n\nAkses penuh tanpa batas.`, { parse_mode: 'Markdown' });
    const u = getUser(userId);
    if (!u) return ctx.reply(
        `📋 *Info Akun Lo*\n\nStatus: *Belum terdaftar*\n\nKetuk 🎁 Coba Gratis untuk trial.\nKetuk ⭐ Premium untuk beli akses.`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
    let statusLine = '';
    if (status === 'regular')      statusLine = `✅ *Reguler* (Aktif)`;
    else if (status === 'trial')   statusLine = `🎁 *Trial* (Aktif)`;
    else if (status === 'expired') statusLine = `❌ *Reguler* (Expired)`;
    else if (status === 'trial_expired') statusLine = `❌ *Trial* (Expired)`;
    const expDate = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
    const sisa    = expDate && new Date(expDate) > new Date() ? formatCountdown(expDate) : 'Expired';
    await ctx.reply(
        `╔${DIVIDER}╗\n║  INFO AKUN\n╚${DIVIDER}╝\n\n` +
        `👤 Nama: ${userDisplayNameEsc(u)}\n🆔 *ID:* \`${u.id}\`\n\n` +
        `${DIVIDER_THIN}\n🏷️ *Status:* ${statusLine}\n` +
        (expDate ? `📅 *Expires:* ${formatDate(expDate)}\n` : '') +
        (sisa !== 'Expired' ? `⏳ *Sisa:* ${sisa}\n` : '') +
        `${DIVIDER_THIN}\n\n` +
        (status === 'expired' || status === 'trial_expired'
            ? `⚠️ Akses lo sudah habis!\nKetuk ⭐ Premium untuk perpanjang.`
            : `⭐ Perpanjang / upgrade: ketuk tombol Premium`),
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('help', async (ctx) => {
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PANDUAN PENGGUNAAN\n╚${DIVIDER}╝\n\n` +
        `${DIVIDER_THIN}\n*📌 CARA PAKAI BOT:*\n${DIVIDER_THIN}\n\n` +
        `*1. Daftar & Aktifkan Akses*\n` +
        `   🎁 Coba Gratis (Trial) — trial ${TRIAL_DURATION_HOURS} jam\n` +
        `   ⭐ Premium — beli paket reguler\n\n` +
        `*2. Login WhatsApp*\n` +
        `   🔑 Login WhatsApp — mulai koneksi\n` +
        `   → Scan QR di WA lo\n\n` +
        `*3. Pilih Grup*\n` +
        `   📋 Daftar Grup — lihat semua grup\n` +
        `   🎯 Pilih Grup — /select "Nama Grup"\n\n` +
        `*4. Kick Anggota*\n` +
        `   🔴 Kick Menu — tampilkan & pilih anggota\n` +
        `   → Centang → Tekan Kick\n\n` +
        `*5. Buat Grup & Import Kontak*\n` +
        `   ➕ Buat Grup WA — /buatgrup "Nama"\n` +
        `   📥 Import VCF — kirim file .vcf\n\n` +
        `${DIVIDER_THIN}\n*⚠️ PENTING:*\n` +
        `• Bot hanya bisa kick jika lo adalah *admin grup*\n` +
        `• Akun WA yang login harus jadi *admin* di grup target\n` +
        `• Trial hanya bisa akses *1 grup*\n` +
        `${DIVIDER_THIN}\n\nButuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('login', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply('✅ *Lo udah login ke WhatsApp!*\nGunakan /logout dulu jika ingin ganti akun.', { parse_mode: 'Markdown' });
    }
    await ctx.reply(`🔄 *Memulai koneksi ke WhatsApp...*\n\n_Harap tunggu, QR code akan segera muncul..._`, { parse_mode: 'Markdown' });
    try { await startLogin(ctx, userId); } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session)           return ctx.reply('❌ Belum ada sesi. Ketik /login.', { parse_mode: 'Markdown' });
    if (session.loggedIn)   return ctx.reply('✅ Lo sudah login! QR tidak diperlukan.', { parse_mode: 'Markdown' });
    if (!session.lastQR)    return ctx.reply('⏳ QR belum tersedia. Tunggu atau /login ulang.', { parse_mode: 'Markdown' });
    session.qrBlocked = true;
    await sendQR(ctx, session.lastQR);
    if (session.qrTimer) clearTimeout(session.qrTimer);
    session.qrTimer = setTimeout(async () => {
        if (!session.loggedIn) {
            session.qrBlocked = false;
            await ctx.reply('⏱ QR expired. Ketik /refreshqr untuk QR baru.', { parse_mode: 'Markdown' });
        }
    }, 5 * 60 * 1000);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Lo belum login!', { parse_mode: 'Markdown' });
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout WhatsApp berhasil.*', { parse_mode: 'Markdown', ...getKeyboard(userId) });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);
    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR Scan';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';
    let accLine = '';
    if (accStatus === 'admin')         accLine = '👑 Admin';
    else if (accStatus === 'regular')  accLine = `✅ Reguler (exp: ${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')    accLine = `🎁 Trial (sisa: ${formatCountdown(u?.trialExpiresAt)})`;
    await ctx.reply(
        `╔${DIVIDER}╗\n║  STATUS\n╚${DIVIDER}╝\n\n` +
        `📡 *WA:* ${waStatus}\n` +
        `🏷️ *Akun:* ${accLine}\n` +
        (session?.groupName ? `🎯 *Grup aktif:* ${session.groupName}\n` : '🎯 *Grup:* Belum dipilih\n'),
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ *Tidak ada grup WA.*', { parse_mode: 'Markdown' });
        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;
        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP WA\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ _Trial: hanya 1 grup ditampilkan_\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `*${i + 1}.* ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        if (isTrial && groups.length > 1) msg += `_+${groups.length - 1} grup lain (upgrade untuk akses semua)_\n\n`;
        msg += `${DIVIDER_THIN}\n/select "Nama Grup" — Pilih grup target`;
        await ctx.reply(msg);
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    let groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (!groupName) return ctx.reply('*Format:* /select "Nama Grup"', { parse_mode: 'Markdown' });
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        const isTrial      = isTrialOnly(userId);
        const allowedGroups = isTrial ? groups.slice(0, 1) : groups;
        const target = allowedGroups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());
        if (!target) {
            const msg = isTrial
                ? `❌ *Grup "${groupName}" tidak ditemukan.*\n\n_Trial hanya bisa akses 1 grup._\nUpgrade: ketuk ⭐ Premium`
                : `❌ *Grup "${groupName}" tidak ditemukan.*\n\nCek nama grup di 📋 Daftar Grup.`;
            return ctx.reply(msg, { parse_mode: 'Markdown' });
        }
        session.groupId   = target.id;
        session.groupName = target.subject;
        await ctx.reply(
            `✅ *Grup terpilih!*\n\n🎯 *${target.subject}*\n👥 Total anggota: ${target.participants?.length || 0} orang\n\n` +
            `Tekan 🔴 Kick Menu untuk mulai kick anggota.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*\n\n📋 Daftar Grup → 🎯 Pilih Grup', { parse_mode: 'Markdown' });
    await ctx.reply('⏳ *Mengambil daftar anggota...*', { parse_mode: 'Markdown' });
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const members  = metadata.participants
            .filter(p => {
                const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));
        if (members.length === 0) {
            return ctx.reply(`ℹ️ *Tidak ada anggota yang bisa dikick.*\n\nSemua anggota adalah admin.`, { parse_mode: 'Markdown' });
        }
        session.members = members;
        kickSelections.set(userId, new Set());
        const keyboard = buildMemberKeyboard(members, kickSelections.get(userId));
        await ctx.reply(
            `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n` +
            `🎯 Grup: *${session.groupName}*\n` +
            `👥 Non-admin: *${members.length} orang*\n\n` +
            `Ketuk nama untuk pilih/batal.\nTekan *Kick Terpilih* jika sudah siap.\n\n` +
            `⚠️ _Aksi kick tidak bisa dibatalkan!_`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  COMMANDS SLASH — ADMIN
// ══════════════════════════════════════════════════════════════

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 *Tidak ada pembayaran pending.*`, { parse_mode: 'Markdown' });
    let msg = `╔${DIVIDER}╗\n║  PEMBAYARAN PENDING\n╚${DIVIDER}╝\n\nTotal: ${list.length} permintaan\n\n`;
    list.forEach((p, i) => {
        const pkg = PACKAGES[p.packageKey];
        msg += `${i + 1}. ${userDisplayName(p)}\n   ID: ${p.id}\n   Paket: ${pkg ? pkg.label : p.packageKey} (${pkg ? formatRupiah(pkg.price) : '-'})\n   Waktu: ${formatDate(p.requestedAt)}\n\n`;
    });
    msg += `${DIVIDER_THIN}\nApprove: /approvepayment [id] [paket]\nReject: /rejectpayment [id]\nPaket: 1bulan / 3bulan / 6bulan / 1tahun`;
    await ctx.reply(msg);
});

tgBot.command('approvepayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];
    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return ctx.reply(
            `*Format:* /approvepayment [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun\nContoh: /approvepayment 123456789 1bulan`,
            { parse_mode: 'Markdown' }
        );
    }
    const result = approvePayment(targetId, pkgKey);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`, { parse_mode: 'Markdown' });
    await ctx.reply(
        `✅ *Pembayaran diapprove!*\n\n🆔 ID: \`${targetId}\`\n📦 Paket: *${result.pkg.label}*\n📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*`,
        { parse_mode: 'Markdown' }
    );
    try {
        await tgBot.telegram.sendMessage(targetId,
            `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n${DIVIDER_THIN}\n` +
            `📦 Paket: *${result.pkg.label}*\n` +
            `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n` +
            `⏳ Durasi: *${formatCountdown(result.expiresAt.toISOString())}*\n` +
            `${DIVIDER_THIN}\n\n` +
            `Akses lo sudah aktif! Tekan 🔑 Login WhatsApp untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

tgBot.command('rejectpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    if (!targetId) return ctx.reply(`*Format:* /rejectpayment [user_id]`, { parse_mode: 'Markdown' });
    const data = loadData();
    const idx  = data.pendingPayment.findIndex(p => p.id === targetId);
    if (idx === -1) return ctx.reply(`❌ Tidak ada pending payment dari ID ${targetId}.`);
    const [user] = data.pendingPayment.splice(idx, 1);
    saveData(data);
    await ctx.reply(`❌ Pembayaran dari ID ${targetId} (${userDisplayName(user)}) direject.`);
    try {
        await tgBot.telegram.sendMessage(targetId,
            `❌ *Pembayaran lo ditolak oleh admin.*\n\n` +
            `Kemungkinan bukti transfer tidak valid.\n` +
            `Hubungi ${PAYMENT_CONTACT} untuk info lebih lanjut.\n\n` +
            `Coba beli lagi: ketuk ⭐ Premium`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

tgBot.command('revokeuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    if (!targetId) return ctx.reply(`*Format:* /revokeuser [user_id]`, { parse_mode: 'Markdown' });
    const user = revokeUser(targetId);
    if (!user) return ctx.reply(`❌ User ID ${targetId} tidak ditemukan.`);
    if (userSessions.has(targetId)) {
        const session = userSessions.get(targetId);
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('revoked')); } catch (_) {}
        userSessions.delete(targetId);
    }
    await ctx.reply(`🚫 Akses ${userDisplayName(user)} (ID: ${targetId}) dicabut.`);
    try {
        await tgBot.telegram.sendMessage(targetId,
            `⚠️ *Akses lo ke ${BOT_NAME} telah dicabut oleh admin.*\n\nHubungi ${PAYMENT_CONTACT} jika ada pertanyaan.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

tgBot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];
    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return ctx.reply(
            `*Format:* /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun\nContoh: /adduser 123456789 1bulan`,
            { parse_mode: 'Markdown' }
        );
    }
    const result = approvePayment(targetId, pkgKey);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`, { parse_mode: 'Markdown' });
    await ctx.reply(
        `✅ *User berhasil ditambahkan!*\n\n🆔 ID: \`${targetId}\`\n📦 Paket: *${result.pkg.label}*\n📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*`,
        { parse_mode: 'Markdown' }
    );
    try {
        await tgBot.telegram.sendMessage(targetId,
            `🎉 *Akses ke ${BOT_NAME} sudah diaktifkan!*\n\n📦 Paket: *${result.pkg.label}*\n📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n\nTekan 🔑 Login WhatsApp untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');
    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });
    const actives = users.filter(u => { const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return exp && new Date(exp) > new Date(); });
    const expired = users.filter(u => { const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return !exp || new Date(exp) <= new Date(); });
    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;
    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n   ID: ${u.id} | ${role}\n   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }
    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: ${u.id}\n   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n(+${expired.length} user expired tidak ditampilkan)`;
    }
    msg += `\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg);
});

// ══════════════════════════════════════════════════════════════
//  VCF PARSER
// ══════════════════════════════════════════════════════════════

function parseVCF(vcfText) {
    const contacts = [];
    const seen     = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
        let name   = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch  = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qpMatch = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qpMatch) {
                try { name = decodeQP(qpMatch[1].trim()); } catch (_) {}
            } else {
                name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
            }
        } else if (nMatch) {
            const raw   = nMatch[0].replace(/^N.*?:/i, '').trim();
            const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
            name = parts.slice(0, 2).reverse().join(' ').trim() || 'Tanpa Nama';
        }
        name = name.replace(/[\x00-\x1F]/g, '').trim() || 'Tanpa Nama';
        const telLines = block.match(/^TEL[^\r\n]*/gim) || [];
        for (const telLine of telLines) {
            let num = telLine.replace(/^TEL[^:]*:/i, '').replace(/[\s\-().]/g, '').trim();
            if (!num) continue;
            num = normalizePhone(num);
            if (!num) continue;
            if (seen.has(num)) continue;
            seen.add(num);
            contacts.push({ name, phone: num });
        }
    }
    return contacts;
}

function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ──────────────────────────────────────────────────────────────
//  DATABASE COUNTRY CODE — SELURUH DUNIA (ITU-T E.164)
// ──────────────────────────────────────────────────────────────

const COUNTRY_CODES = [
    { cc: '62',  local: '0',  min: 7,  max: 13 },
    { cc: '60',  local: '0',  min: 7,  max: 11 },
    { cc: '65',  local: '',   min: 8,  max: 8  },
    { cc: '66',  local: '0',  min: 8,  max: 9  },
    { cc: '63',  local: '0',  min: 9,  max: 10 },
    { cc: '84',  local: '0',  min: 8,  max: 10 },
    { cc: '95',  local: '0',  min: 7,  max: 10 },
    { cc: '855', local: '0',  min: 8,  max: 9  },
    { cc: '856', local: '0',  min: 8,  max: 9  },
    { cc: '673', local: '',   min: 7,  max: 7  },
    { cc: '670', local: '',   min: 7,  max: 8  },
    { cc: '91',  local: '0',  min: 10, max: 10 },
    { cc: '92',  local: '0',  min: 10, max: 10 },
    { cc: '880', local: '0',  min: 9,  max: 10 },
    { cc: '94',  local: '0',  min: 9,  max: 9  },
    { cc: '977', local: '0',  min: 9,  max: 10 },
    { cc: '960', local: '',   min: 7,  max: 7  },
    { cc: '975', local: '',   min: 8,  max: 8  },
    { cc: '93',  local: '0',  min: 9,  max: 9  },
    { cc: '86',  local: '0',  min: 10, max: 11 },
    { cc: '81',  local: '0',  min: 9,  max: 11 },
    { cc: '82',  local: '0',  min: 9,  max: 11 },
    { cc: '852', local: '',   min: 8,  max: 8  },
    { cc: '853', local: '',   min: 8,  max: 8  },
    { cc: '886', local: '0',  min: 9,  max: 9  },
    { cc: '976', local: '0',  min: 8,  max: 8  },
    { cc: '7',   local: '8',  min: 10, max: 10 },
    { cc: '998', local: '0',  min: 9,  max: 9  },
    { cc: '996', local: '0',  min: 9,  max: 9  },
    { cc: '993', local: '8',  min: 8,  max: 8  },
    { cc: '992', local: '0',  min: 9,  max: 9  },
    { cc: '994', local: '0',  min: 9,  max: 9  },
    { cc: '995', local: '0',  min: 9,  max: 9  },
    { cc: '374', local: '0',  min: 8,  max: 8  },
    { cc: '966', local: '0',  min: 9,  max: 9  },
    { cc: '971', local: '0',  min: 9,  max: 9  },
    { cc: '974', local: '',   min: 8,  max: 8  },
    { cc: '965', local: '',   min: 8,  max: 8  },
    { cc: '973', local: '',   min: 8,  max: 8  },
    { cc: '968', local: '',   min: 8,  max: 8  },
    { cc: '967', local: '0',  min: 9,  max: 9  },
    { cc: '962', local: '0',  min: 9,  max: 9  },
    { cc: '961', local: '0',  min: 7,  max: 8  },
    { cc: '963', local: '0',  min: 9,  max: 9  },
    { cc: '964', local: '0',  min: 9,  max: 10 },
    { cc: '98',  local: '0',  min: 10, max: 10 },
    { cc: '972', local: '0',  min: 9,  max: 9  },
    { cc: '970', local: '0',  min: 9,  max: 9  },
    { cc: '44',  local: '0',  min: 9,  max: 11 },
    { cc: '49',  local: '0',  min: 9,  max: 12 },
    { cc: '33',  local: '0',  min: 9,  max: 9  },
    { cc: '39',  local: '0',  min: 9,  max: 11 },
    { cc: '34',  local: '',   min: 9,  max: 9  },
    { cc: '351', local: '',   min: 9,  max: 9  },
    { cc: '31',  local: '0',  min: 9,  max: 9  },
    { cc: '32',  local: '0',  min: 8,  max: 9  },
    { cc: '41',  local: '0',  min: 9,  max: 9  },
    { cc: '43',  local: '0',  min: 9,  max: 13 },
    { cc: '45',  local: '',   min: 8,  max: 8  },
    { cc: '46',  local: '0',  min: 7,  max: 13 },
    { cc: '47',  local: '',   min: 8,  max: 8  },
    { cc: '358', local: '0',  min: 8,  max: 12 },
    { cc: '353', local: '0',  min: 8,  max: 9  },
    { cc: '354', local: '',   min: 7,  max: 7  },
    { cc: '352', local: '',   min: 6,  max: 11 },
    { cc: '356', local: '',   min: 8,  max: 8  },
    { cc: '357', local: '',   min: 8,  max: 8  },
    { cc: '30',  local: '',   min: 10, max: 10 },
    { cc: '380', local: '0',  min: 9,  max: 9  },
    { cc: '48',  local: '0',  min: 9,  max: 9  },
    { cc: '420', local: '',   min: 9,  max: 9  },
    { cc: '421', local: '0',  min: 9,  max: 9  },
    { cc: '36',  local: '06', min: 8,  max: 9  },
    { cc: '40',  local: '0',  min: 9,  max: 9  },
    { cc: '359', local: '0',  min: 8,  max: 9  },
    { cc: '385', local: '0',  min: 8,  max: 9  },
    { cc: '381', local: '0',  min: 8,  max: 9  },
    { cc: '387', local: '0',  min: 8,  max: 8  },
    { cc: '386', local: '0',  min: 8,  max: 8  },
    { cc: '371', local: '',   min: 8,  max: 8  },
    { cc: '372', local: '',   min: 7,  max: 8  },
    { cc: '370', local: '8',  min: 8,  max: 8  },
    { cc: '375', local: '80', min: 9,  max: 9  },
    { cc: '373', local: '0',  min: 8,  max: 8  },
    { cc: '355', local: '0',  min: 9,  max: 9  },
    { cc: '389', local: '0',  min: 8,  max: 8  },
    { cc: '382', local: '0',  min: 8,  max: 8  },
    { cc: '383', local: '0',  min: 8,  max: 8  },
    { cc: '1',   local: '1',  min: 10, max: 10 },
    { cc: '52',  local: '01', min: 10, max: 10 },
    { cc: '502', local: '',   min: 8,  max: 8  },
    { cc: '503', local: '',   min: 8,  max: 8  },
    { cc: '504', local: '',   min: 8,  max: 8  },
    { cc: '505', local: '',   min: 8,  max: 8  },
    { cc: '506', local: '',   min: 8,  max: 8  },
    { cc: '507', local: '',   min: 8,  max: 8  },
    { cc: '509', local: '',   min: 8,  max: 8  },
    { cc: '53',  local: '0',  min: 8,  max: 8  },
    { cc: '1809', local: '',  min: 10, max: 10 },
    { cc: '1876', local: '',  min: 10, max: 10 },
    { cc: '1868', local: '',  min: 10, max: 10 },
    { cc: '1246', local: '',  min: 10, max: 10 },
    { cc: '1784', local: '',  min: 10, max: 10 },
    { cc: '55',  local: '0',  min: 10, max: 11 },
    { cc: '54',  local: '0',  min: 10, max: 11 },
    { cc: '56',  local: '0',  min: 9,  max: 9  },
    { cc: '57',  local: '0',  min: 10, max: 10 },
    { cc: '51',  local: '0',  min: 9,  max: 9  },
    { cc: '58',  local: '0',  min: 10, max: 10 },
    { cc: '593', local: '0',  min: 9,  max: 9  },
    { cc: '591', local: '0',  min: 8,  max: 8  },
    { cc: '595', local: '0',  min: 9,  max: 9  },
    { cc: '598', local: '0',  min: 8,  max: 9  },
    { cc: '592', local: '',   min: 7,  max: 7  },
    { cc: '597', local: '',   min: 6,  max: 7  },
    { cc: '20',  local: '0',  min: 9,  max: 10 },
    { cc: '212', local: '0',  min: 9,  max: 9  },
    { cc: '213', local: '0',  min: 9,  max: 9  },
    { cc: '216', local: '',   min: 8,  max: 8  },
    { cc: '218', local: '0',  min: 9,  max: 9  },
    { cc: '249', local: '0',  min: 9,  max: 9  },
    { cc: '234', local: '0',  min: 7,  max: 10 },
    { cc: '233', local: '0',  min: 9,  max: 9  },
    { cc: '221', local: '',   min: 9,  max: 9  },
    { cc: '225', local: '0',  min: 8,  max: 10 },
    { cc: '223', local: '',   min: 8,  max: 8  },
    { cc: '226', local: '',   min: 8,  max: 8  },
    { cc: '227', local: '',   min: 8,  max: 8  },
    { cc: '228', local: '',   min: 8,  max: 8  },
    { cc: '229', local: '',   min: 8,  max: 8  },
    { cc: '224', local: '',   min: 8,  max: 9  },
    { cc: '232', local: '',   min: 8,  max: 8  },
    { cc: '231', local: '',   min: 7,  max: 8  },
    { cc: '222', local: '',   min: 8,  max: 8  },
    { cc: '220', local: '',   min: 7,  max: 7  },
    { cc: '245', local: '',   min: 7,  max: 9  },
    { cc: '238', local: '',   min: 7,  max: 7  },
    { cc: '254', local: '0',  min: 9,  max: 9  },
    { cc: '255', local: '0',  min: 9,  max: 9  },
    { cc: '256', local: '0',  min: 9,  max: 9  },
    { cc: '251', local: '0',  min: 9,  max: 9  },
    { cc: '252', local: '',   min: 7,  max: 8  },
    { cc: '253', local: '',   min: 8,  max: 8  },
    { cc: '291', local: '',   min: 7,  max: 7  },
    { cc: '250', local: '0',  min: 9,  max: 9  },
    { cc: '257', local: '',   min: 8,  max: 8  },
    { cc: '258', local: '',   min: 9,  max: 9  },
    { cc: '261', local: '0',  min: 9,  max: 9  },
    { cc: '262', local: '0',  min: 9,  max: 9  },
    { cc: '269', local: '',   min: 7,  max: 7  },
    { cc: '230', local: '',   min: 8,  max: 8  },
    { cc: '248', local: '',   min: 7,  max: 7  },
    { cc: '243', local: '0',  min: 9,  max: 9  },
    { cc: '242', local: '',   min: 9,  max: 9  },
    { cc: '237', local: '',   min: 9,  max: 9  },
    { cc: '236', local: '',   min: 8,  max: 8  },
    { cc: '235', local: '',   min: 8,  max: 8  },
    { cc: '240', local: '',   min: 9,  max: 9  },
    { cc: '241', local: '',   min: 7,  max: 8  },
    { cc: '239', local: '',   min: 7,  max: 7  },
    { cc: '27',  local: '0',  min: 9,  max: 9  },
    { cc: '263', local: '0',  min: 9,  max: 9  },
    { cc: '260', local: '0',  min: 9,  max: 9  },
    { cc: '265', local: '0',  min: 9,  max: 9  },
    { cc: '266', local: '0',  min: 8,  max: 8  },
    { cc: '267', local: '',   min: 8,  max: 8  },
    { cc: '264', local: '0',  min: 9,  max: 9  },
    { cc: '268', local: '',   min: 8,  max: 8  },
    { cc: '244', local: '0',  min: 9,  max: 9  },
    { cc: '61',  local: '0',  min: 9,  max: 9  },
    { cc: '64',  local: '0',  min: 8,  max: 10 },
    { cc: '679', local: '',   min: 7,  max: 7  },
    { cc: '675', local: '',   min: 7,  max: 8  },
    { cc: '677', local: '',   min: 5,  max: 7  },
    { cc: '678', local: '',   min: 7,  max: 7  },
    { cc: '685', local: '',   min: 5,  max: 7  },
    { cc: '686', local: '',   min: 8,  max: 8  },
    { cc: '688', local: '',   min: 5,  max: 6  },
    { cc: '689', local: '',   min: 6,  max: 6  },
    { cc: '690', local: '',   min: 4,  max: 4  },
    { cc: '691', local: '',   min: 7,  max: 7  },
    { cc: '692', local: '',   min: 7,  max: 7  },
    { cc: '680', local: '',   min: 7,  max: 7  },
    { cc: '682', local: '',   min: 5,  max: 5  },
    { cc: '683', local: '',   min: 4,  max: 4  },
    { cc: '676', local: '',   min: 5,  max: 7  },
];

COUNTRY_CODES.sort((a, b) => b.cc.length - a.cc.length);

function normalizePhone(raw) {
    const hasPlus = raw.trimStart().startsWith('+');
    let digits    = raw.replace(/\D/g, '');
    if (!digits) return null;
    let withCC = null;
    if (hasPlus) {
        withCC = digits;
    } else if (digits.startsWith('00')) {
        withCC = digits.slice(2);
    } else if (digits.startsWith('011') && digits.length >= 13) {
        withCC = digits.slice(3);
    }
    if (withCC) {
        const validated = validateWithCC(withCC);
        if (validated) return validated;
        if (hasPlus && withCC.length >= 7) return withCC;
    }
    const candidates = [];
    for (const entry of COUNTRY_CODES) {
        const { cc, local, min, max } = entry;
        if (local && digits.startsWith(local)) {
            const sub = digits.slice(local.length);
            if (sub.length >= min && sub.length <= max) {
                candidates.push({ full: cc + sub, cc, priority: local.length });
            }
        }
        if (!local || local === '') {
            if (digits.startsWith(cc)) {
                const sub = digits.slice(cc.length);
                if (sub.length >= min && sub.length <= max) {
                    candidates.push({ full: digits, cc, priority: 0 });
                }
            }
        }
    }
    if (candidates.length > 0) {
        candidates.sort((a, b) => b.priority - a.priority || b.full.length - a.full.length);
        return candidates[0].full;
    }
    const directMatch = validateWithCC(digits);
    if (directMatch) return directMatch;
    if (digits.length >= 7 && digits.length <= 15) return digits;
    return null;
}

function validateWithCC(digits) {
    for (const entry of COUNTRY_CODES) {
        if (digits.startsWith(entry.cc)) {
            const sub = digits.slice(entry.cc.length);
            if (sub.length >= entry.min && sub.length <= entry.max) return digits;
        }
    }
    if (digits.length >= 7 && digits.length <= 15) return digits;
    return null;
}

// State VCF per user
const vcfPending = new Map();

// ══════════════════════════════════════════════════════════════
//  COMMAND /buatgrup
// ══════════════════════════════════════════════════════════════

tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  BUAT GRUP WA BARU\n╚${DIVIDER}╝\n\n` +
            `*Format:* /buatgrup "Nama Grup"\n\nContoh:\n/buatgrup "Arisan RT 05"\n/buatgrup "Tim Sales Jakarta"`,
            { parse_mode: 'Markdown' }
        );
    }
    await ctx.reply(`⏳ *Membuat grup "${namaGrup}"...*`, { parse_mode: 'Markdown' });
    try {
        const result    = await session.sock.groupCreate(namaGrup, []);
        const groupId   = result.id;
        const groupName = namaGrup;
        session.groupId   = groupId;
        session.groupName = groupName;
        let inviteLink = '-';
        try {
            const code = await session.sock.groupInviteCode(groupId);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (_) {}
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📥 Import VCF Sekarang', `importvcf_start_${userId}`)],
            [Markup.button.callback('🔴 Kick Menu', `goto_kickmenu_${userId}`)],
        ]);
        await ctx.reply(
            `╔${DIVIDER}╗\n║  GRUP BERHASIL DIBUAT!\n╚${DIVIDER}╝\n\n` +
            `✅ *${groupName}*\n\n${DIVIDER_THIN}\n` +
            `🆔 *ID Grup:*\n\`${groupId}\`\n\n` +
            `🔗 *Link Invite:*\n${inviteLink}\n${DIVIDER_THIN}\n\n` +
            `Grup ini sudah jadi *grup aktif* lo.\nMau langsung import kontak dari VCF?`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    } catch (err) {
        await ctx.reply(`❌ *Gagal buat grup:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  COMMAND /importvcf
// ══════════════════════════════════════════════════════════════

tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    if (!session.groupId) {
        return ctx.reply(
            `❌ *Pilih grup dulu!*\n\n📋 Daftar Grup → 🎯 Pilih Grup\natau /buatgrup "Nama Grup Baru"`,
            { parse_mode: 'Markdown' }
        );
    }
    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n${DIVIDER_THIN}\n📎 *Kirim file .vcf sekarang*\n\n` +
        `File VCF yang didukung:\n• vCard 2.1, 3.0, 4.0\n• Nomor lokal 08xx → otomatis 628xx\n` +
        `• Nomor internasional +628xx\n• Multi-nomor per kontak\n• Nama dengan emoji/CJK/Arab ✓\n` +
        `${DIVIDER_THIN}\n\n_Kirim file .vcf langsung ke chat ini..._`,
        { parse_mode: 'Markdown' }
    );
});

// ══════════════════════════════════════════════════════════════
//  HANDLER FILE VCF
// ══════════════════════════════════════════════════════════════

tgBot.on('document', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;
    const doc   = ctx.message.document;
    const fname = doc.file_name || '';
    if (!fname.toLowerCase().endsWith('.vcf') && doc.mime_type !== 'text/x-vcard' && doc.mime_type !== 'text/vcard') {
        return ctx.reply('⚠️ *File harus berformat .vcf*\n\nKirim ulang file yang benar.', { parse_mode: 'Markdown' });
    }
    await ctx.reply('⏳ *Membaca file VCF...*', { parse_mode: 'Markdown' });
    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp     = await fetch(fileLink.href);
        const vcfText  = await resp.text();
        const contacts = parseVCF(vcfText);
        if (contacts.length === 0) {
            vcfPending.delete(userId);
            return ctx.reply(
                `❌ *Tidak ada nomor valid ditemukan di file VCF.*\n\nPastikan file VCF berisi nomor telepon yang valid.\nCoba lagi: tekan 📥 Import VCF`,
                { parse_mode: 'Markdown' }
            );
        }
        pending.contacts    = contacts;
        pending.waitingFile = false;
        vcfPending.set(userId, pending);
        let preview = `╔${DIVIDER}╗\n║  PREVIEW KONTAK VCF\n╚${DIVIDER}╝\n\n`;
        preview += `📊 *Total kontak valid: ${contacts.length}*\n🎯 *Target grup:* ${pending.groupName}\n\n`;
        preview += `${DIVIDER_THIN}\n*5 Kontak Pertama:*\n${DIVIDER_THIN}\n`;
        contacts.slice(0, 5).forEach((c, i) => {
            preview += `${i + 1}. ${c.name}\n   📱 +${c.phone}\n`;
        });
        if (contacts.length > 5) preview += `\n_...dan ${contacts.length - 5} kontak lainnya_\n`;
        preview += `\n${DIVIDER_THIN}\n⚠️ _Bot hanya bisa tambahkan kontak yang sudah punya WhatsApp_`;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`✅ Tambahkan Semua (${contacts.length} kontak)`, 'vcf_add_all')],
            [Markup.button.callback(`📦 Per Batch 5 kontak`, 'vcf_add_batch')],
            [Markup.button.callback('❌ Batal', 'vcf_cancel')],
        ]);
        await ctx.reply(preview, { parse_mode: 'Markdown', ...keyboard });
    } catch (err) {
        vcfPending.delete(userId);
        await ctx.reply(`❌ *Gagal baca file:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  HELPER: TAMBAH KONTAK KE GRUP
// ══════════════════════════════════════════════════════════════

async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Session WA berakhir.* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    const total   = contacts.length;
    let berhasil  = 0, gagal = 0, notWA = 0;
    const gagalList = [];
    const statusMsg = await ctx.reply(`⏳ *Menambahkan ${total} kontak ke grup...*\n\n_0 / ${total} selesai_`, { parse_mode: 'Markdown' });
    for (let i = 0; i < contacts.length; i++) {
        const c   = contacts[i];
        const jid = `${c.phone}@s.whatsapp.net`;
        try {
            const [result] = await session.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) { notWA++; continue; }
            await session.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            await new Promise(r => setTimeout(r, 800));
            if ((i + 1) % 5 === 0 || i + 1 === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, statusMsg.message_id, null,
                        `⏳ *Menambahkan kontak...*\n\n${i + 1} / ${total} diproses\n✅ Berhasil: ${berhasil}  |  ❌ Tidak di WA: ${notWA}`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (_) {}
            }
        } catch (err) {
            gagal++;
            gagalList.push(`• ${c.name} (+${c.phone}): ${err.message}`);
            await new Promise(r => setTimeout(r, 500));
        }
    }
    let hasil = `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n🎯 *Grup:* ${groupName}\n\n${DIVIDER_THIN}\n`;
    hasil += `✅ *Berhasil ditambah:* ${berhasil} kontak\n📵 *Tidak punya WA:* ${notWA} kontak\n❌ *Error:* ${gagal} kontak\n${DIVIDER_THIN}\n`;
    if (gagalList.length > 0 && gagalList.length <= 5) hasil += `\n*Detail error:*\n${gagalList.join('\n')}\n`;
    hasil += `\nTekan 📥 Import VCF untuk import lagi\nTekan 🔴 Kick Menu untuk kick anggota`;
    await ctx.reply(hasil, { parse_mode: 'Markdown' });
    vcfPending.delete(userId);
}

// ══════════════════════════════════════════════════════════════
//  CALLBACKS INLINE KEYBOARD
// ══════════════════════════════════════════════════════════════

tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    const jid     = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired. Tekan 🔴 Kick Menu.');
    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus dari pilihan');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan ke pilihan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId   = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    const session  = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    await ctx.answerCbQuery();
    if (!session || !session.loggedIn) return ctx.reply('❌ *Session expired.* Tekan 🔑 Login WhatsApp.', { parse_mode: 'Markdown' });
    if (!selected || selected.size === 0) return ctx.reply('⚠️ *Belum ada yang dipilih!*\n\nCentang dulu anggota yang mau dikick.', { parse_mode: 'Markdown' });
    const jidList = Array.from(selected);
    await ctx.reply(`⏳ *Mengkick ${jidList.length} anggota...*\n_Harap tunggu..._`, { parse_mode: 'Markdown' });
    let berhasil = 0, gagal = 0;
    const gagalList = [];
    for (const jid of jidList) {
        try {
            await session.sock.groupParticipantsUpdate(session.groupId, [jid], 'remove');
            berhasil++;
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            gagal++;
            gagalList.push(`• ${jid.split('@')[0]}: ${err.message}`);
        }
    }
    kickSelections.set(userId, new Set());
    let result = `╔${DIVIDER}╗\n║  HASIL KICK\n╚${DIVIDER}╝\n\n`;
    result += `✅ *Berhasil dikick:* ${berhasil} orang\n❌ *Gagal:* ${gagal} orang\n`;
    if (gagalList.length > 0) result += `\n*Detail gagal:*\n${gagalList.join('\n')}`;
    result += `\n\nTekan 🔴 Kick Menu untuk kick lagi`;
    await ctx.reply(result, { parse_mode: 'Markdown' });
});

tgBot.action('cancel_kick', async (ctx) => {
    const userId = ctx.from.id;
    kickSelections.set(userId, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Kick dibatalkan.* Pilihan dihapus.', { parse_mode: 'Markdown' });
    try { await ctx.deleteMessage(); } catch (_) {}
});

tgBot.action(/^importvcf_start_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn || !session.groupId) {
        return ctx.reply('❌ Pilih grup dulu atau login ulang.', { parse_mode: 'Markdown' });
    }
    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n📎 *Kirim file .vcf sekarang ke chat ini.*\n\n` +
        `Format yang didukung: vCard 2.1, 3.0, 4.0\nNomor lokal 08xx otomatis dikonversi ke 628xx`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.action(/^goto_kickmenu_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Tekan 🔴 Kick Menu untuk membuka menu kick anggota.');
});

tgBot.action('vcf_add_all', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('Memulai proses...');
    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts || pending.contacts.length === 0) {
        return ctx.reply('❌ Data kontak tidak ditemukan. Ulangi 📥 Import VCF.', { parse_mode: 'Markdown' });
    }
    await addContactsToGroup(ctx, userId, pending.contacts, pending.groupId, pending.groupName);
});

tgBot.action('vcf_add_batch', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('Mode batch aktif...');
    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts || pending.contacts.length === 0) {
        return ctx.reply('❌ Data kontak tidak ditemukan. Ulangi 📥 Import VCF.', { parse_mode: 'Markdown' });
    }
    const contacts    = pending.contacts;
    const batchSize   = 5;
    const totalBatch  = Math.ceil(contacts.length / batchSize);
    await ctx.reply(
        `📦 *Mode batch aktif*\n\nTotal: ${contacts.length} kontak → ${totalBatch} batch (@5 kontak)\n\n_Memulai batch 1..._`,
        { parse_mode: 'Markdown' }
    );
    for (let b = 0; b < totalBatch; b++) {
        const batch   = contacts.slice(b * batchSize, (b + 1) * batchSize);
        await ctx.reply(`⏳ *Batch ${b + 1}/${totalBatch}* (${batch.length} kontak)...`, { parse_mode: 'Markdown' });
        const session = userSessions.get(userId);
        if (!session || !session.loggedIn) break;
        let ok = 0, skip = 0, err = 0;
        for (const c of batch) {
            try {
                const [result] = await session.sock.onWhatsApp(c.phone);
                if (!result || !result.exists) { skip++; continue; }
                await session.sock.groupParticipantsUpdate(pending.groupId, [result.jid], 'add');
                ok++;
                await new Promise(r => setTimeout(r, 800));
            } catch (_) {
                err++;
                await new Promise(r => setTimeout(r, 500));
            }
        }
        await ctx.reply(
            `✅ *Batch ${b + 1}/${totalBatch} selesai*\nBerhasil: ${ok} | Skip (no WA): ${skip} | Error: ${err}`,
            { parse_mode: 'Markdown' }
        );
        if (b + 1 < totalBatch) await new Promise(r => setTimeout(r, 2000));
    }
    vcfPending.delete(userId);
    await ctx.reply(
        `🎉 *Import selesai!*\n\nTekan 📥 Import VCF untuk import lagi\nTekan 🔴 Kick Menu untuk kick anggota`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.action('vcf_cancel', async (ctx) => {
    const userId = ctx.from.id;
    vcfPending.delete(userId);
    await ctx.answerCbQuery('Import dibatalkan');
    await ctx.reply('✖ *Import VCF dibatalkan.*', { parse_mode: 'Markdown' });
    try { await ctx.deleteMessage(); } catch (_) {}
});

// ══════════════════════════════════════════════════════════════
//  AUTO-NOTIF EXPIRED (setiap 1 jam)
// ══════════════════════════════════════════════════════════════

setInterval(async () => {
    const users = getAllUsers();
    const now   = new Date();
    for (const u of users) {
        if (u.notifiedExpiry) continue;
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        if (!exp) continue;
        const msLeft = new Date(exp) - now;
        if (msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000) {
            try {
                const label = u.role === 'trial' ? 'Trial' : 'Akses';
                await tgBot.telegram.sendMessage(u.id,
                    `⚠️ *PERINGATAN: ${label} lo akan segera habis!*\n\n` +
                    `⏳ Sisa: *${formatCountdown(exp)}*\n\n` +
                    `Perpanjang sekarang agar tidak terputus:\nKetuk ⭐ Premium`,
                    { parse_mode: 'Markdown', ...KB_LANDING }
                );
            } catch (_) {}
        }
    }
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════════════════════

tgBot.launch().then(() => {
    console.log('');
    console.log('╔══════════════════════════════════╗');
    console.log('║    WA KICKER BOT v2.0 AKTIF      ║');
    console.log('╠══════════════════════════════════╣');
    console.log(`║  Admin IDs: ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial: ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Paket: ${Object.keys(PACKAGES).join(' | ')}`);
    console.log('╚══════════════════════════════════╝');
    console.log('');
});

process.on('SIGINT', () => {
    console.log('\nMatiin bot...');
    tgBot.stop('SIGINT');
    process.exit();
});
