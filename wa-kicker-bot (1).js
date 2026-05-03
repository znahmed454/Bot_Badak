const { Telegraf, Markup } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════╗
//   WA KICKER PRO — Bot Manajemen Grup WhatsApp
// ╚══════════════════════════════════════════════════════════════╝

// ┌─────────────────────────────────────────────────────────────┐
//   KONFIGURASI — WAJIB DIISI SEBELUM DIJALANKAN
// └─────────────────────────────────────────────────────────────┘
const CONFIG = {
    BOT_TOKEN:       'ISI_TOKEN_BOT_TELEGRAM_LO_DISINI',
    ADMIN_IDS:       [123456789],   // ← ganti dengan ID Telegram lo
    BOT_NAME:        'WA Kicker Pro',
    TRIAL_HOURS:     24,
    TRIAL_MAX_GROUPS: 1,
    HARGA: {
        '1bulan': 'Rp 25.000',
        '3bulan': 'Rp 60.000',
        '6bulan': 'Rp 100.000',
        '1tahun': 'Rp 175.000',
    },
    DATA_FILE: './data_users.json',
};

// ┌─────────────────────────────────────────────────────────────┐
//   INISIALISASI
// └─────────────────────────────────────────────────────────────┘
const tgBot = new Telegraf(CONFIG.BOT_TOKEN);
const userSessions = new Map();
const kickSelections = new Map();

const AUTH_FOLDER = './auth_states';
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER);

// ╔══════════════════════════════════════════════════════════════╗
//   REPLY KEYBOARD — Definisi tombol menu (harus di atas sebelum dipakai)
// ╚══════════════════════════════════════════════════════════════╝

// Keyboard untuk user reguler/trial yang sudah login WA
const KEYBOARD_USER_LOGGEDIN = Markup.keyboard([
    ['📱 Login WA',    '🔌 Logout WA',    '📡 Status'],
    ['📋 Daftar Grup', '🎯 Pilih Grup',   '🔴 Kick Menu'],
    ['🆕 Buat Grup',   '📥 Import VCF',   '💰 Paket Saya'],
    ['💎 Upgrade',     '❓ Bantuan',       '📊 Info Akun'],
]).resize();

// Keyboard untuk user reguler/trial yang BELUM login WA
const KEYBOARD_USER = Markup.keyboard([
    ['📱 Login WA',    '📡 Status',       '💰 Paket Saya'],
    ['💎 Upgrade',     '❓ Bantuan',       '📊 Info Akun'],
]).resize();

// Keyboard untuk admin
const KEYBOARD_ADMIN = Markup.keyboard([
    ['📱 Login WA',    '🔌 Logout WA',    '📡 Status'],
    ['📋 Daftar Grup', '🎯 Pilih Grup',   '🔴 Kick Menu'],
    ['🆕 Buat Grup',   '📥 Import VCF',   '📊 Info Akun'],
    ['👥 User List',   '🛒 Pending',      '📈 Statistik'],
]).resize();

// Keyboard untuk user baru (belum terdaftar/expired)
const KEYBOARD_GUEST = Markup.keyboard([
    ['🎁 Mulai Trial Gratis'],
    ['💎 Lihat Paket',  '❓ Bantuan'],
]).resize();

// ╔══════════════════════════════════════════════════════════════╗
//   ESCAPE — Aman untuk SEMUA karakter: emoji, CJK, simbol, dsb
// ╚══════════════════════════════════════════════════════════════╝
// Gunakan fungsi ini pada SEMUA data dari user sebelum dimasukkan
// ke pesan dengan parse_mode: 'Markdown'
function esc(str) {
    if (str === null || str === undefined) return '';
    // Escape karakter spesial Telegram MarkdownV1: _ * ` [
    return String(str).replace(/([_*`\[])/g, '\\$1');
}

// Untuk pesan yang TIDAK pakai parse_mode (plain text) — tidak perlu escape
// Untuk pesan yang pakai parse_mode: 'Markdown' — SEMUA data user harus esc()

// ╔══════════════════════════════════════════════════════════════╗
//   DATABASE
// ╚══════════════════════════════════════════════════════════════╝
function loadDB() {
    if (!fs.existsSync(CONFIG.DATA_FILE)) {
        const init = { users: {}, pendingOrders: [] };
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        // Migrasi dari format lama (approved/pending array) ke format baru
        if (!raw.users) {
            raw.users = {};
            if (Array.isArray(raw.approved)) {
                raw.approved.forEach(u => {
                    raw.users[u.id] = {
                        id: u.id,
                        username: u.username || null,
                        firstName: u.firstName || u.first_name || '',
                        lastName: u.lastName || u.last_name || '',
                        plan: 'reguler',
                        status: 'active',
                        subStart: u.approvedAt || new Date().toISOString(),
                        subEnd: calcSubEnd('1bulan', new Date(u.approvedAt || Date.now())).toISOString(),
                        maxGroups: 999,
                        createdAt: u.approvedAt || new Date().toISOString(),
                    };
                });
            }
        }
        if (!raw.pendingOrders) raw.pendingOrders = [];
        return raw;
    } catch (_) {
        return { users: {}, pendingOrders: [] };
    }
}

function saveDB(db) {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(db, null, 2));
}

function getUser(userId) {
    const db = loadDB();
    return db.users[String(userId)] || null;
}

function upsertUser(userId, data) {
    const db = loadDB();
    const key = String(userId);
    db.users[key] = { ...(db.users[key] || {}), ...data };
    saveDB(db);
    return db.users[key];
}

function isAdmin(userId) {
    return CONFIG.ADMIN_IDS.includes(Number(userId));
}

function calcSubEnd(paket, fromDate = new Date()) {
    const d = new Date(fromDate);
    if (paket === '1bulan') d.setMonth(d.getMonth() + 1);
    if (paket === '3bulan') d.setMonth(d.getMonth() + 3);
    if (paket === '6bulan') d.setMonth(d.getMonth() + 6);
    if (paket === '1tahun') d.setFullYear(d.getFullYear() + 1);
    return d;
}

// Cek akses: return { ok, plan, reason, ... }
function checkAccess(userId) {
    if (isAdmin(userId)) return { ok: true, plan: 'admin' };
    const user = getUser(userId);
    if (!user)                     return { ok: false, reason: 'not_registered' };
    if (user.status === 'banned')  return { ok: false, reason: 'banned' };
    if (user.status === 'pending') return { ok: false, reason: 'pending' };

    const now = new Date();

    if (user.plan === 'trial') {
        if (!user.trialEnd || new Date(user.trialEnd) < now) {
            upsertUser(userId, { status: 'expired' });
            return { ok: false, reason: 'trial_expired' };
        }
        return { ok: true, plan: 'trial', trialEnd: user.trialEnd, maxGroups: CONFIG.TRIAL_MAX_GROUPS };
    }

    if (user.plan === 'reguler') {
        if (!user.subEnd || new Date(user.subEnd) < now) {
            upsertUser(userId, { status: 'expired' });
            return { ok: false, reason: 'sub_expired' };
        }
        return { ok: true, plan: 'reguler', subEnd: user.subEnd, maxGroups: 999 };
    }

    return { ok: false, reason: 'no_plan' };
}

// ╔══════════════════════════════════════════════════════════════╗
//   HELPER TEKS — UI Profesional (plain text, no parse_mode)
// ╚══════════════════════════════════════════════════════════════╝
const LINE = '─────────────────────────';

function formatDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    });
}

function formatSisa(endStr) {
    const diff = new Date(endStr) - new Date();
    if (diff <= 0) return 'Sudah habis';
    const hari = Math.floor(diff / 86400000);
    const jam  = Math.floor((diff % 86400000) / 3600000);
    return hari > 0 ? `${hari} hari ${jam} jam` : `${jam} jam`;
}

function planLabel(plan, status) {
    if (plan === 'admin')                          return '👑 Admin';
    if (plan === 'reguler' && status === 'active') return '💎 Reguler';
    if (plan === 'trial'   && status === 'active') return '🔰 Trial';
    if (status === 'expired')                      return '🔴 Expired';
    if (status === 'banned')                       return '🚫 Banned';
    return '⚪ Tidak aktif';
}

// Ambil nama user dengan aman (plain text, no escape needed for plain messages)
function getName(u) {
    return [u.firstName || u.first_name, u.lastName || u.last_name]
        .filter(Boolean).join(' ') || 'Tanpa nama';
}

// ╔══════════════════════════════════════════════════════════════╗
//   MIDDLEWARE — Cek akses, semua pesan plain text (no Markdown)
// ╚══════════════════════════════════════════════════════════════╝
async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const access = checkAccess(userId);
    if (access.ok) return next();

    const msgs = {
        not_registered: `🔒 Belum terdaftar\n\nKetik /start untuk mendaftar dan mulai Trial Gratis ${CONFIG.TRIAL_HOURS} jam!`,
        pending:        `⏳ Permintaan akses masih menunggu konfirmasi admin.`,
        trial_expired:  `🔴 Trial sudah habis\n\nKetik /beli untuk berlangganan Reguler.`,
        sub_expired:    `🔴 Langganan sudah habis\n\nKetik /beli untuk perpanjang.`,
        banned:         `🚫 Akun kamu diblokir. Hubungi admin.`,
        no_plan:        `🔒 Tidak ada paket aktif\n\nKetik /beli untuk berlangganan.`,
    };
    await ctx.reply(msgs[access.reason] || '❌ Akses ditolak.');
}

// ╔══════════════════════════════════════════════════════════════╗
//   WHATSAPP — KONEKSI
// ╚══════════════════════════════════════════════════════════════╝
async function sendQR(ctx, qr) {
    try {
        const buf = await QRCode.toBuffer(qr, {
            type: 'png', width: 512, margin: 2,
            color: { dark: '#111111', light: '#FFFFFF' }
        });
        await ctx.replyWithPhoto({ source: buf }, {
            caption:
                `📲 Scan QR Code di WhatsApp\n${LINE}\n\n` +
                `Cara:\n` +
                `1. Buka WhatsApp di HP\n` +
                `2. Ketuk ⋮ → Perangkat Tertaut\n` +
                `3. Ketuk Tautkan Perangkat\n` +
                `4. Arahkan kamera ke QR ini\n\n` +
                `QR berlaku 5 menit. Expired? Ketik /refreshqr`
        });
    } catch (err) {
        await ctx.reply(`❌ Gagal kirim QR: ${err.message}`);
    }
}

async function startWALogin(ctx, userId) {
    if (userSessions.has(userId)) {
        const old = userSessions.get(userId);
        if (old.qrTimer) clearTimeout(old.qrTimer);
        try { old.sock.end(new Error('restart')); } catch (_) {}
        userSessions.delete(userId);
    }

    const authDir = path.join(AUTH_FOLDER, `user_${userId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Windows', 'Chrome', '120.0.0'],
        logger: pino({ level: 'silent' })
    });

    const session = {
        sock, saveCreds,
        qrTimer: null, lastQR: null, qrBlocked: false,
        loggedIn: false, groupId: null, groupName: null, members: [],
        // Fitur buat grup & import VCF
        pendingGroupName: null,   // nama grup yang akan dibuat
        vcfContacts: [],          // kontak hasil parse VCF yang siap dimasukkan
        vcfTargetGroupId: null,   // ID grup tujuan import kontak
        vcfTargetGroupName: null, // nama grup tujuan import kontak
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
                        await ctx.reply('⚠️ QR sudah expired. Ketik /refreshqr untuk QR baru.');
                    }
                }, 5 * 60 * 1000);
            }
        }

        if (connection === 'close') {
            if (session.qrTimer) clearTimeout(session.qrTimer);
            const code = lastDisconnect?.error?.output?.statusCode;
            userSessions.delete(userId);
            if (!session.loggedIn) {
                await ctx.reply(code === DisconnectReason.loggedOut
                    ? '❌ Session ditolak WA. Ketik /login untuk coba lagi.'
                    : '⚠️ Koneksi terputus. Ketik /login untuk coba lagi.'
                );
            } else {
                await ctx.reply('⚠️ Koneksi WA terputus. Ketik /login untuk reconnect.');
            }
        }

        if (connection === 'open') {
            session.loggedIn = true;
            if (session.qrTimer) clearTimeout(session.qrTimer);
            const waNum = sock.user?.id?.split(':')[0] || '?';
            const kb = isAdmin(userId) ? KEYBOARD_ADMIN : KEYBOARD_USER_LOGGEDIN;
            await ctx.reply(
                `✅ Login WhatsApp Berhasil!\n${LINE}\n\n` +
                `Nomor: +${waNum}\n\n` +
                `Ketuk tombol di bawah untuk mulai.`,
                kb
            );
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

function buildMemberKeyboard(members, selected) {
    const buttons = members.map(m => {
        const tick = selected.has(m.jid) ? '✅' : '○';
        // Nama anggota dari nomor WA — aman, tidak ada karakter Markdown
        return [Markup.button.callback(`${tick} ${m.name}`, `toggle_${m.jid}`)];
    });
    buttons.push([
        Markup.button.callback(`🔴 Kick (${selected.size} dipilih)`, 'do_kick'),
        Markup.button.callback('✖ Batal', 'cancel_kick')
    ]);
    return Markup.inlineKeyboard(buttons);
}

// ╔══════════════════════════════════════════════════════════════╗
//   /start
// ╚══════════════════════════════════════════════════════════════╝
tgBot.start(async (ctx) => {
    const userId = ctx.from.id;
    // Nama dari Telegram — plain text, aman tanpa escape karena pesan plain
    const firstName = ctx.from.first_name || 'Pengguna';

    // ── Admin
    if (isAdmin(userId)) {
        await ctx.reply(
            `${CONFIG.BOT_NAME} — Panel Admin\n${LINE}\n\n` +
            `Halo, ${firstName}!\n\n` +
            `MANAJEMEN USER\n` +
            `/pending — Antrian order\n` +
            `/userlist — Semua user\n` +
            `/addtrial [id] — Beri trial\n` +
            `/addsub [id] [paket] — Aktifkan langganan\n` +
            `/revoke [id] — Cabut akses\n` +
            `/ban [id] — Blokir user\n` +
            `/cekuser [id] — Detail user\n` +
            `/stats — Statistik bot\n\n` +
            `FITUR BOT\n` +
            `/login — Login WhatsApp\n` +
            `/logout — Logout WhatsApp\n` +
            `/groups — Daftar grup\n` +
            `/select — Pilih grup\n` +
            `/kickmenu — Kick anggota\n` +
            `/buatgrup — Buat grup WA baru\n` +
            `/importvcf — Import kontak dari VCF\n` +
            `/status — Status koneksi\n` +
            `/myplan — Info paket`,
            KEYBOARD_ADMIN
        );
        return;
    }

    const access = checkAccess(userId);

    // ── User aktif
    if (access.ok) {
        const user = getUser(userId);
        const badge = planLabel(user?.plan, user?.status);
        const sisa = user?.plan === 'trial'
            ? formatSisa(user.trialEnd)
            : user?.subEnd ? formatSisa(user.subEnd) : '-';

        await ctx.reply(
            `${CONFIG.BOT_NAME}\n${LINE}\n\n` +
            `Halo, ${firstName}!\n\n` +
            `Status : ${badge}\n` +
            `Sisa   : ${sisa}\n\n` +
            `${LINE}\n\n` +
            `Ketuk tombol di bawah untuk mulai.`,
            KEYBOARD_USER_LOGGEDIN
        );
        return;
    }

    // ── User baru
    if (access.reason === 'not_registered') {
        await ctx.reply(
            `Selamat Datang di ${CONFIG.BOT_NAME}!\n${LINE}\n\n` +
            `Halo ${firstName}! Bot ini membantu kamu mengelola anggota grup WhatsApp dengan mudah.\n\n` +
            `🎁 TRIAL GRATIS ${CONFIG.TRIAL_HOURS} JAM\n` +
            `Coba semua fitur tanpa bayar!\n\n` +
            `${LINE}\n\n` +
            `💎 PAKET BERLANGGANAN\n` +
            `1 Bulan  — ${CONFIG.HARGA['1bulan']}\n` +
            `3 Bulan  — ${CONFIG.HARGA['3bulan']}\n` +
            `6 Bulan  — ${CONFIG.HARGA['6bulan']}\n` +
            `1 Tahun  — ${CONFIG.HARGA['1tahun']}\n\n` +
            `${LINE}\n\n` +
            `Ketuk tombol di bawah untuk mulai:`,
            KEYBOARD_GUEST
        );
        return;
    }

    // ── Expired
    await ctx.reply(
        `${CONFIG.BOT_NAME}\n${LINE}\n\n` +
        `Halo ${firstName}!\n\n` +
        `Status: 🔴 Akses tidak aktif\n\n` +
        `Ketuk tombol 💎 Lihat Paket di bawah untuk berlangganan.`,
        KEYBOARD_GUEST
    );
});

// ╔══════════════════════════════════════════════════════════════╗
//   TRIAL
// ╚══════════════════════════════════════════════════════════════╝
tgBot.action('start_trial', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    // Nama dari Telegram — plain text
    const firstName = ctx.from.first_name || 'Pengguna';
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Tanpa nama';
    const uname = ctx.from.username ? '@' + ctx.from.username : '-';

    const existing = getUser(userId);
    if (existing) {
        return await ctx.reply(
            `❌ Kamu sudah pernah mendaftar sebelumnya.\n\nKetik /myplan untuk cek status akun.`
        );
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + CONFIG.TRIAL_HOURS * 3600000);

    upsertUser(userId, {
        id: userId,
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || '',
        lastName: ctx.from.last_name || '',
        plan: 'trial',
        status: 'active',
        trialStart: now.toISOString(),
        trialEnd: trialEnd.toISOString(),
        maxGroups: CONFIG.TRIAL_MAX_GROUPS,
        createdAt: now.toISOString(),
    });

    // Notif admin — plain text, nama user aman
    for (const adminId of CONFIG.ADMIN_IDS) {
        try {
            await tgBot.telegram.sendMessage(adminId,
                `🔔 USER BARU — TRIAL\n\n` +
                `Nama  : ${name}\n` +
                `User  : ${uname}\n` +
                `ID    : ${userId}\n` +
                `Mulai : ${formatDate(now.toISOString())}\n` +
                `Habis : ${formatDate(trialEnd.toISOString())}`
            );
        } catch (_) {}
    }

    await ctx.reply(
        `🎉 Trial Aktif!\n${LINE}\n\n` +
        `Selamat ${firstName}, trial kamu sudah aktif!\n\n` +
        `Durasi   : ${CONFIG.TRIAL_HOURS} jam\n` +
        `Habis    : ${formatDate(trialEnd.toISOString())}\n` +
        `Max grup : ${CONFIG.TRIAL_MAX_GROUPS} grup\n\n` +
        `${LINE}\n\n` +
        `Mulai dengan 📱 Login WA di tombol bawah.`,
        KEYBOARD_USER
    );
});

// ╔══════════════════════════════════════════════════════════════╗
//   /beli — Paket berlangganan
// ╚══════════════════════════════════════════════════════════════╝
tgBot.command('beli', async (ctx) => {
    await ctx.reply(
        `💎 Paket Berlangganan ${CONFIG.BOT_NAME}\n${LINE}\n\n` +
        `Nikmati akses penuh tanpa batas!\n\n` +
        `1 Bulan  — ${CONFIG.HARGA['1bulan']}\n` +
        `3 Bulan  — ${CONFIG.HARGA['3bulan']} (hemat 20%)\n` +
        `6 Bulan  — ${CONFIG.HARGA['6bulan']} (hemat 33%)\n` +
        `1 Tahun  — ${CONFIG.HARGA['1tahun']} (hemat 42%)\n\n` +
        `${LINE}\n\n` +
        `Yang kamu dapatkan:\n` +
        `• Kelola anggota tidak terbatas\n` +
        `• Akses semua grup WA\n` +
        `• Kick anggota massal\n` +
        `• Support prioritas\n\n` +
        `${LINE}\n\n` +
        `Pilih paket:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('1 Bulan', 'order_1bulan'), Markup.button.callback('3 Bulan', 'order_3bulan')],
            [Markup.button.callback('6 Bulan', 'order_6bulan'), Markup.button.callback('1 Tahun', 'order_1tahun')]
        ])
    );
});

tgBot.action('show_plans', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        `💎 Paket Berlangganan\n${LINE}\n\n` +
        `1 Bulan  — ${CONFIG.HARGA['1bulan']}\n` +
        `3 Bulan  — ${CONFIG.HARGA['3bulan']}\n` +
        `6 Bulan  — ${CONFIG.HARGA['6bulan']}\n` +
        `1 Tahun  — ${CONFIG.HARGA['1tahun']}\n\n` +
        `Pilih paket:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('1 Bulan', 'order_1bulan'), Markup.button.callback('3 Bulan', 'order_3bulan')],
            [Markup.button.callback('6 Bulan', 'order_6bulan'), Markup.button.callback('1 Tahun', 'order_1tahun')]
        ])
    );
});

// Handler order — reusable
async function handleOrder(userId, fromInfo, paket) {
    const name  = [fromInfo.first_name, fromInfo.last_name].filter(Boolean).join(' ') || 'Tanpa nama';
    const uname = fromInfo.username ? '@' + fromInfo.username : '-';

    const db = loadDB();
    const already = db.pendingOrders.find(p => p.id === userId && p.paket === paket);
    if (!already) {
        db.pendingOrders.push({
            id: userId, paket, nama: name, username: uname,
            requestedAt: new Date().toISOString()
        });
        saveDB(db);
    }

    // Notif admin — plain text
    for (const adminId of CONFIG.ADMIN_IDS) {
        try {
            await tgBot.telegram.sendMessage(adminId,
                `🛒 ORDER BARU\n\n` +
                `Nama  : ${name}\n` +
                `User  : ${uname}\n` +
                `ID    : ${userId}\n` +
                `Paket : ${paket.toUpperCase()} — ${CONFIG.HARGA[paket]}\n\n` +
                `Setelah bayar konfirmasi:\n` +
                `/addsub ${userId} ${paket}`
            );
        } catch (_) {}
    }

    return {
        text: `🛒 Order Diterima!\n${LINE}\n\n` +
            `Paket : ${paket.toUpperCase()}\n` +
            `Harga : ${CONFIG.HARGA[paket]}\n\n` +
            `${LINE}\n\n` +
            `Admin sudah mendapat notifikasi order kamu.\n` +
            `Lakukan pembayaran lalu konfirmasi ke admin.\n\n` +
            `Akses akan diaktifkan otomatis setelah konfirmasi. ✅`
    };
}

['1bulan', '3bulan', '6bulan', '1tahun'].forEach(paket => {
    tgBot.action(`order_${paket}`, async (ctx) => {
        await ctx.answerCbQuery();
        const { text } = await handleOrder(ctx.from.id, ctx.from, paket);
        await ctx.reply(text);
    });
});

tgBot.command('order', async (ctx) => {
    const paket = ctx.message.text.split(' ')[1]?.toLowerCase();
    const valid = ['1bulan', '3bulan', '6bulan', '1tahun'];
    if (!paket || !valid.includes(paket)) {
        return await ctx.reply(
            `Format: /order [paket]\n\n` +
            `Tersedia:\n` +
            `/order 1bulan — ${CONFIG.HARGA['1bulan']}\n` +
            `/order 3bulan — ${CONFIG.HARGA['3bulan']}\n` +
            `/order 6bulan — ${CONFIG.HARGA['6bulan']}\n` +
            `/order 1tahun — ${CONFIG.HARGA['1tahun']}`
        );
    }
    const { text } = await handleOrder(ctx.from.id, ctx.from, paket);
    await ctx.reply(text);
});

// ╔══════════════════════════════════════════════════════════════╗
//   /myplan — Info paket user
// ╚══════════════════════════════════════════════════════════════╝
tgBot.command('myplan', async (ctx) => {
    const userId = ctx.from.id;
    if (isAdmin(userId)) return await ctx.reply(`✅ Kamu adalah admin bot. Akses penuh tanpa batas!`);

    const user = getUser(userId);
    if (!user) return await ctx.reply(`❓ Belum terdaftar\n\nKetik /start untuk daftar dan mulai trial gratis.`);

    const access = checkAccess(userId);
    const badge  = planLabel(user.plan, user.status);
    const name   = getName(user);

    let detail = '';
    if (user.plan === 'trial') {
        detail = `Trial habis  : ${formatDate(user.trialEnd)}\nSisa trial   : ${formatSisa(user.trialEnd)}\nMax grup     : ${CONFIG.TRIAL_MAX_GROUPS} grup`;
    } else if (user.plan === 'reguler') {
        detail = `Mulai        : ${formatDate(user.subStart)}\nHabis        : ${formatDate(user.subEnd)}\nSisa         : ${formatSisa(user.subEnd)}`;
    } else {
        detail = 'Tidak ada paket aktif.';
    }

    await ctx.reply(
        `Info Paket Saya\n${LINE}\n\n` +
        `Nama   : ${name}\n` +
        `Status : ${badge}\n\n` +
        `${LINE}\n` +
        `${detail}\n` +
        `${LINE}\n\n` +
        (access.ok ? `✅ Akses aktif!` : `❌ Akses tidak aktif.\n\nKetik /beli untuk berlangganan.`)
    );
});

// ╔══════════════════════════════════════════════════════════════╗
//   COMMANDS ADMIN
// ╚══════════════════════════════════════════════════════════════╝

tgBot.command('pending', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const db = loadDB();
    const orders = db.pendingOrders || [];
    if (orders.length === 0) return await ctx.reply('ℹ️ Tidak ada order pending.');

    let msg = `🛒 Antrian Order (${orders.length})\n${LINE}\n\n`;
    orders.forEach((o, i) => {
        msg += `${i + 1}. ${o.nama} (${o.username})\n   ID: ${o.id} | ${o.paket} — ${CONFIG.HARGA[o.paket]}\n   ${new Date(o.requestedAt).toLocaleString('id-ID')}\n\n`;
    });
    msg += `Aktifkan: /addsub [id] [paket]`;
    await ctx.reply(msg);
});

tgBot.command('addtrial', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (!targetId) return await ctx.reply('Format: /addtrial [user_id]');

    const now      = new Date();
    const trialEnd = new Date(now.getTime() + CONFIG.TRIAL_HOURS * 3600000);
    const existing = getUser(targetId) || {};

    upsertUser(targetId, {
        ...existing, id: targetId,
        plan: 'trial', status: 'active',
        trialStart: now.toISOString(), trialEnd: trialEnd.toISOString(),
        maxGroups: CONFIG.TRIAL_MAX_GROUPS,
        createdAt: existing.createdAt || now.toISOString(),
    });

    await ctx.reply(`✅ Trial ${CONFIG.TRIAL_HOURS} jam diaktifkan untuk ID ${targetId}\nHabis: ${formatDate(trialEnd.toISOString())}`);
    try {
        await tgBot.telegram.sendMessage(targetId,
            `🎁 Trial Diaktifkan!\n${LINE}\n\n` +
            `Masa trial ${CONFIG.TRIAL_HOURS} jam sudah aktif!\n` +
            `Habis: ${formatDate(trialEnd.toISOString())}\n\n` +
            `Ketik /start untuk mulai.`
        );
    } catch (_) {}
});

tgBot.command('addsub', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const args = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const paket    = args[2]?.toLowerCase();
    const valid    = ['1bulan', '3bulan', '6bulan', '1tahun'];

    if (!targetId || !valid.includes(paket)) {
        return await ctx.reply('Format: /addsub [user_id] [paket]\nPaket: 1bulan / 3bulan / 6bulan / 1tahun');
    }

    const existing = getUser(targetId) || {};
    const fromDate = existing.plan === 'reguler' && existing.subEnd && new Date(existing.subEnd) > new Date()
        ? new Date(existing.subEnd) : new Date();
    const subEnd = calcSubEnd(paket, fromDate);

    upsertUser(targetId, {
        ...existing, id: targetId,
        plan: 'reguler', status: 'active',
        subStart: fromDate.toISOString(), subEnd: subEnd.toISOString(),
        maxGroups: 999,
    });

    // Hapus dari pending orders
    const db = loadDB();
    db.pendingOrders = (db.pendingOrders || []).filter(p => !(p.id === targetId && p.paket === paket));
    saveDB(db);

    await ctx.reply(
        `✅ Langganan diaktifkan!\n\n` +
        `ID    : ${targetId}\n` +
        `Paket : ${paket.toUpperCase()}\n` +
        `Habis : ${formatDate(subEnd.toISOString())}`
    );
    try {
        await tgBot.telegram.sendMessage(targetId,
            `🎉 Langganan Aktif!\n${LINE}\n\n` +
            `Paket ${paket.toUpperCase()} sudah aktif!\n\n` +
            `Habis  : ${formatDate(subEnd.toISOString())}\n` +
            `Sisa   : ${formatSisa(subEnd.toISOString())}\n\n` +
            `Ketik /start untuk mulai.`,
            KEYBOARD_USER
        );
    } catch (_) {}
});

tgBot.command('revoke', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (!targetId) return await ctx.reply('Format: /revoke [user_id]');

    const user = getUser(targetId);
    if (!user) return await ctx.reply(`ℹ️ User ID ${targetId} tidak ditemukan.`);

    upsertUser(targetId, { plan: null, status: 'expired', subEnd: null, trialEnd: null });

    if (userSessions.has(targetId)) {
        const s = userSessions.get(targetId);
        if (s.qrTimer) clearTimeout(s.qrTimer);
        try { s.sock.end(new Error('revoked')); } catch (_) {}
        userSessions.delete(targetId);
    }

    await ctx.reply(`✅ Akses ${getName(user)} (ID: ${targetId}) sudah dicabut.`);
    try { await tgBot.telegram.sendMessage(targetId, `⚠️ Akses kamu dicabut admin.\n\nKetik /beli untuk berlangganan kembali.`); } catch (_) {}
});

tgBot.command('ban', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (!targetId) return await ctx.reply('Format: /ban [user_id]');

    upsertUser(targetId, { status: 'banned', plan: null });
    if (userSessions.has(targetId)) {
        const s = userSessions.get(targetId);
        if (s.qrTimer) clearTimeout(s.qrTimer);
        try { s.sock.end(new Error('banned')); } catch (_) {}
        userSessions.delete(targetId);
    }
    await ctx.reply(`✅ User ID ${targetId} sudah diblokir.`);
});

tgBot.command('cekuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (!targetId) return await ctx.reply('Format: /cekuser [user_id]');

    const user = getUser(targetId);
    if (!user) return await ctx.reply(`ℹ️ User ID ${targetId} tidak ditemukan.`);

    const access = checkAccess(targetId);
    const badge  = planLabel(user.plan, user.status);

    await ctx.reply(
        `Detail User\n${LINE}\n\n` +
        `Nama     : ${getName(user)}\n` +
        `Username : ${user.username ? '@' + user.username : '-'}\n` +
        `ID       : ${user.id}\n` +
        `Status   : ${badge}\n\n` +
        `${LINE}\n` +
        `Daftar   : ${formatDate(user.createdAt)}\n` +
        (user.trialEnd ? `Trial habis: ${formatDate(user.trialEnd)}\n` : '') +
        (user.subEnd   ? `Sub habis  : ${formatDate(user.subEnd)}\n`   : '') +
        (user.subEnd && user.status === 'active' ? `Sisa       : ${formatSisa(user.subEnd)}\n` : '') +
        `${LINE}\n` +
        `Akses    : ${access.ok ? '✅ Aktif' : '❌ Tidak aktif'}`
    );
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const db  = loadDB();
    const all = Object.values(db.users || {});
    if (all.length === 0) return await ctx.reply('ℹ️ Belum ada user terdaftar.');

    const aktif   = all.filter(u => u.status === 'active');
    const expired = all.filter(u => u.status === 'expired');
    const banned  = all.filter(u => u.status === 'banned');

    let msg = `Daftar User (Total: ${all.length})\n${LINE}\n\n`;
    msg += `Aktif: ${aktif.length}  Expired: ${expired.length}  Banned: ${banned.length}\n\n`;
    aktif.slice(0, 20).forEach((u, i) => {
        const uname = u.username ? '@' + u.username : '-';
        msg += `${i + 1}. ${getName(u)} (${uname})\n   ID: ${u.id} | ${planLabel(u.plan, u.status)}\n`;
    });
    if (aktif.length > 20) msg += `\n...dan ${aktif.length - 20} user lainnya`;

    await ctx.reply(msg);
});

tgBot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return await ctx.reply('⛔ Akses ditolak.');
    const db  = loadDB();
    const all = Object.values(db.users || {});

    await ctx.reply(
        `Statistik ${CONFIG.BOT_NAME}\n${LINE}\n\n` +
        `Total user     : ${all.length}\n` +
        `Trial aktif    : ${all.filter(u => u.plan === 'trial'   && u.status === 'active').length}\n` +
        `Reguler aktif  : ${all.filter(u => u.plan === 'reguler' && u.status === 'active').length}\n` +
        `Expired        : ${all.filter(u => u.status === 'expired').length}\n` +
        `Banned         : ${all.filter(u => u.status === 'banned').length}\n` +
        `Order pending  : ${(db.pendingOrders || []).length}\n` +
        `${LINE}\n` +
        `WA online      : ${userSessions.size} sesi`
    );
});

// ╔══════════════════════════════════════════════════════════════╗
//   FITUR BOT (WAJIB AKSES AKTIF)
// ╚══════════════════════════════════════════════════════════════╝

tgBot.command('login', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session?.loggedIn) return await ctx.reply('⚠️ Kamu sudah login WA. Ketik /logout dulu untuk ganti akun.');
    await ctx.reply('⏳ Menghubungkan ke WhatsApp...\n\nTunggu QR code muncul...');
    try { await startWALogin(ctx, userId); }
    catch (err) { await ctx.reply(`❌ Gagal koneksi: ${err.message}`); }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const session = userSessions.get(ctx.from.id);
    if (!session)          return await ctx.reply('❌ Belum ada sesi. Ketik /login dulu.');
    if (session.loggedIn)  return await ctx.reply('ℹ️ Sudah login, tidak perlu QR.');
    if (!session.lastQR)   return await ctx.reply('⚠️ QR belum tersedia. Tunggu atau /login ulang.');

    session.qrBlocked = true;
    await sendQR(ctx, session.lastQR);
    if (session.qrTimer) clearTimeout(session.qrTimer);
    session.qrTimer = setTimeout(async () => {
        if (!session.loggedIn) {
            session.qrBlocked = false;
            await ctx.reply('⚠️ QR expired. Ketik /refreshqr untuk QR baru.');
        }
    }, 5 * 60 * 1000);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return await ctx.reply('❌ Kamu belum login WA.');
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authDir = path.join(AUTH_FOLDER, `user_${userId}`);
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ Logout WhatsApp berhasil.');
    } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
        userSessions.delete(userId);
    }
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    const user    = isAdmin(userId) ? null : getUser(userId);
    const badge   = isAdmin(userId) ? '👑 Admin' : planLabel(user?.plan, user?.status);
    const sisa    = user?.plan === 'reguler' && user?.subEnd
        ? formatSisa(user.subEnd)
        : user?.plan === 'trial' && user?.trialEnd
            ? formatSisa(user.trialEnd) + ' (trial)' : '-';

    let waStatus = '⚫ Belum login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu scan QR';
    if (session?.loggedIn) {
        const waNum = session.sock?.user?.id?.split(':')[0] || '?';
        waStatus = `🟢 Online (+${waNum})`;
    }

    await ctx.reply(
        `Status Koneksi\n${LINE}\n\n` +
        `Akun   : ${badge}\n` +
        `Sisa   : ${sisa}\n\n` +
        `${LINE}\n` +
        `WA     : ${waStatus}\n` +
        `Grup   : ${session?.groupName || 'Belum dipilih'}\n` +
        `${LINE}`
    );
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WhatsApp dulu! Ketik /login');

    await ctx.reply('⏳ Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return await ctx.reply('ℹ️ Kamu tidak punya grup WhatsApp.');

        const access    = checkAccess(userId);
        const maxGroups = access.maxGroups || 999;

        let msg = `Daftar Grup WhatsApp\n${LINE}\n\n`;
        groups.forEach((g, i) => {
            const lock = (access.plan === 'trial' && i >= maxGroups) ? '[TERKUNCI] ' : '';
            // Nama grup dari WA — plain text, aman
            msg += `${i + 1}. ${lock}${g.subject}\n   ${g.participants?.length || 0} anggota\n\n`;
        });
        msg += LINE + '\n';
        if (access.plan === 'trial') msg += `(Trial: max ${maxGroups} grup)\n\n`;
        msg += `Pilih: /select Nama Grup`;

        await ctx.reply(msg);
    } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WhatsApp dulu!');

    const groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (!groupName) return await ctx.reply('Format: /select Nama Grup');

    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        const target = groups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());
        if (!target) return await ctx.reply(`❌ Grup "${groupName}" tidak ditemukan.\n\nCek /groups untuk daftar.`);

        // Batasan trial
        const access = checkAccess(userId);
        if (access.plan === 'trial') {
            const idx = groups.findIndex(g => g.id === target.id);
            if (idx >= CONFIG.TRIAL_MAX_GROUPS) {
                return await ctx.reply(
                    `🔒 Fitur Terbatas\n\nTrial hanya bisa akses ${CONFIG.TRIAL_MAX_GROUPS} grup.\n\nKetik /beli untuk upgrade.`
                );
            }
        }

        session.groupId   = target.id;
        session.groupName = target.subject;

        await ctx.reply(
            `✅ Grup berhasil dipilih!\n\n` +
            `Nama    : ${target.subject}\n` +
            `Anggota : ${target.participants?.length || 0} orang\n\n` +
            `Ketik /kickmenu untuk kick anggota.`
        );
    } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WhatsApp dulu!');
    if (!session.groupId)   return await ctx.reply('❌ Pilih grup dulu! Ketik /groups lalu /select');

    await ctx.reply('⏳ Mengambil daftar anggota...');
    try {
        const meta    = await session.sock.groupMetadata(session.groupId);
        const myJid   = session.sock.user.id.replace(/:.*@/, '@');
        const members = meta.participants
            .filter(p => {
                const isMe   = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm  = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));

        if (members.length === 0) return await ctx.reply('ℹ️ Tidak ada anggota yang bisa dikick.');

        session.members = members;
        kickSelections.set(userId, new Set());

        await ctx.reply(
            `Menu Kick Anggota\n${LINE}\n\n` +
            `Grup     : ${session.groupName}\n` +
            `Non-admin: ${members.length} orang\n\n` +
            `Ketuk nama untuk pilih. Tekan Kick jika sudah selesai.`,
            buildMemberKeyboard(members, kickSelections.get(userId))
        );
    } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
});

// ╔══════════════════════════════════════════════════════════════╗
//   FITUR BARU: BUAT GRUP WA
// ╚══════════════════════════════════════════════════════════════╝

// ── /buatgrup [nama grup] ─────────────────────────────
// Alur: user ketik /buatgrup Nama Grup
//       → bot buat grup kosong dengan user sebagai admin
//       → bot kasih link invite dan tanya mau import VCF tidak
tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WhatsApp dulu! Ketik /login');

    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) {
        return await ctx.reply(
            `Cara Buat Grup WA Baru\n${LINE}\n\n` +
            `Format: /buatgrup Nama Grup\n\n` +
            `Contoh:\n` +
            `/buatgrup Komunitas Bisnis 2025\n` +
            `/buatgrup Alumni SMA 1\n\n` +
            `Setelah grup dibuat, kamu bisa langsung import\n` +
            `kontak dari file VCF ke dalam grup tersebut.`
        );
    }

    await ctx.reply(`⏳ Membuat grup "${namaGrup}"...`);

    try {
        // Buat grup kosong — Baileys butuh minimal 1 peserta,
        // kita isi dengan nomor sendiri lalu langsung hapus (workaround)
        const myJid = session.sock.user.id;

        const result = await session.sock.groupCreate(namaGrup, []);

        // Simpan sebagai grup aktif di session
        session.groupId   = result.id;
        session.groupName = namaGrup;

        // Buat link invite
        let inviteLink = '';
        try {
            const inviteCode = await session.sock.groupInviteCode(result.id);
            inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
        } catch (_) {}

        await ctx.reply(
            `✅ Grup Berhasil Dibuat!\n${LINE}\n\n` +
            `Nama    : ${namaGrup}\n` +
            `ID Grup : ${result.id}\n\n` +
            (inviteLink ? `Link undangan:\n${inviteLink}\n\n` : '') +
            `${LINE}\n\n` +
            `Grup ini sekarang jadi grup aktif kamu.\n\n` +
            `Mau langsung import kontak dari file VCF?\n` +
            `Kirim file .vcf ke chat ini sekarang, atau ketik /importvcf`,
            Markup.inlineKeyboard([
                [Markup.button.callback('📥 Import VCF Sekarang', `vcf_target_${result.id}`)],
                [Markup.button.callback('⏭ Lewati', 'vcf_skip')]
            ])
        );
    } catch (err) {
        // Beberapa versi WA tidak izinkan buat grup tanpa anggota awal
        await ctx.reply(
            `❌ Gagal buat grup: ${err.message}\n\n` +
            `Catatan: WhatsApp kadang menolak buat grup kosong.\n` +
            `Coba /buatgrup lagi atau pastikan WA kamu tidak dibatasi.`
        );
    }
});

// ╔══════════════════════════════════════════════════════════════╗
//   FITUR BARU: IMPORT KONTAK DARI VCF
// ╚══════════════════════════════════════════════════════════════╝

// ── Parser VCF ────────────────────────────────────────
// Mendukung vCard 2.1, 3.0, 4.0
// Ekstrak semua nomor telepon, bersihkan jadi format internasional
function parseVCF(content) {
    const contacts = [];
    // Pisah per vCard
    const cards = content.split(/END:VCARD/i).map(s => s.trim()).filter(Boolean);

    for (const card of cards) {
        const lines = card.split(/\r?\n/);
        let name = '';
        const phones = [];

        for (let raw of lines) {
            // Handle line folding (spasi/tab di awal = lanjutan baris sebelumnya)
            raw = raw.trim();
            if (!raw) continue;

            // Ambil nama
            if (/^FN:/i.test(raw)) {
                name = raw.replace(/^FN:/i, '').trim();
            } else if (!name && /^N:/i.test(raw)) {
                // N:Lastname;Firstname → ambil sebagai fallback
                const parts = raw.replace(/^N:/i, '').split(';');
                name = parts.filter(Boolean).reverse().join(' ').trim();
            }

            // Ambil nomor telepon — berbagai format
            // TEL:+628xxx, TEL;TYPE=CELL:+628xxx, TEL;CELL:..., item1.TEL:...
            if (/^(?:item\d+\.)?TEL[;:](.+)/i.test(raw)) {
                const match = raw.match(/^(?:item\d+\.)?TEL[^:]*:(.+)/i);
                if (match) {
                    let num = match[1].trim()
                        // Hapus karakter non-digit kecuali +
                        .replace(/[^\d+]/g, '')
                        // Hapus ekstensi (x123)
                        .replace(/x\d+$/i, '');

                    if (!num) continue;

                    // Normalisasi ke format internasional
                    // Kalau mulai 0 → asumsi Indonesia → ganti jadi 62
                    if (num.startsWith('0')) {
                        num = '62' + num.slice(1);
                    }
                    // Kalau mulai 62 tapi tidak ada + → tambah 62
                    if (!num.startsWith('+')) {
                        if (num.startsWith('62')) {
                            num = num; // sudah benar
                        } else if (num.length >= 7) {
                            num = '62' + num; // asumsi Indonesia
                        }
                    } else {
                        num = num.slice(1); // hapus +, Baileys pakai tanpa +
                    }

                    // Filter nomor yang terlalu pendek atau terlalu panjang
                    if (num.length >= 7 && num.length <= 15) {
                        phones.push(num);
                    }
                }
            }
        }

        // Deduplikasi nomor dalam 1 kontak
        const uniquePhones = [...new Set(phones)];
        for (const phone of uniquePhones) {
            contacts.push({ name: name || phone, phone });
        }
    }

    // Deduplikasi global berdasarkan nomor
    const seen = new Set();
    return contacts.filter(c => {
        if (seen.has(c.phone)) return false;
        seen.add(c.phone);
        return true;
    });
}

// ── State sementara untuk proses import VCF ──────────
// userId → { groupId, groupName, contacts, offset }
const vcfImportState = new Map();

// ── /importvcf — mulai proses import ─────────────────
tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WhatsApp dulu! Ketik /login');
    if (!session.groupId)   return await ctx.reply(
        '❌ Belum ada grup aktif.\n\n' +
        'Pilih dulu:\n' +
        '• /select Nama Grup — pilih grup yang sudah ada\n' +
        '• /buatgrup Nama Grup — buat grup baru'
    );

    await ctx.reply(
        `Import Kontak dari VCF\n${LINE}\n\n` +
        `Grup tujuan: ${session.groupName}\n\n` +
        `Kirim file .vcf ke chat ini sekarang.\n\n` +
        `Catatan:\n` +
        `• File VCF bisa diekspor dari Kontak HP\n` +
        `• Semua format nomor didukung (lokal & internasional)\n` +
        `• Nomor yang tidak punya WA akan dilewati otomatis`
    );

    // Set flag tunggu VCF
    session.vcfTargetGroupId   = session.groupId;
    session.vcfTargetGroupName = session.groupName;
    session.waitingVcf         = true;
});

// Callback dari tombol "Import VCF Sekarang" setelah buat grup
tgBot.action(/^vcf_target_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId  = ctx.from.id;
    const groupId = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session) return await ctx.reply('❌ Session expired. Ketik /login ulang.');

    session.vcfTargetGroupId   = groupId;
    session.vcfTargetGroupName = session.groupName;
    session.waitingVcf         = true;

    await ctx.reply(
        `📥 Siap terima file VCF\n${LINE}\n\n` +
        `Grup tujuan: ${session.groupName}\n\n` +
        `Kirim file .vcf sekarang.`
    );
});

tgBot.action('vcf_skip', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`ℹ️ Dilewati. Ketik /importvcf kapan saja untuk import kontak.`);
});

// ── Handler: terima file dokumen (.vcf) ──────────────
tgBot.on('document', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    const doc     = ctx.message.document;

    // Cek apakah sedang menunggu VCF
    if (!session?.waitingVcf) {
        // Bukan saat nunggu VCF — abaikan
        return;
    }

    // Validasi tipe file
    const fname = doc.file_name || '';
    const mime  = doc.mime_type || '';
    const isVcf = fname.toLowerCase().endsWith('.vcf') ||
                  mime === 'text/vcard' ||
                  mime === 'text/x-vcard';

    if (!isVcf) {
        return await ctx.reply('❌ File harus berformat .vcf\n\nKirim file kontak dengan ekstensi .vcf');
    }

    // Cek ukuran file (max 5MB)
    if (doc.file_size > 5 * 1024 * 1024) {
        return await ctx.reply('❌ File terlalu besar (max 5MB)');
    }

    await ctx.reply(`⏳ Memproses file ${fname}...`);

    try {
        // Download file dari Telegram
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const https    = require('https');
        const http     = require('http');

        const vcfContent = await new Promise((resolve, reject) => {
            const proto = fileLink.href.startsWith('https') ? https : http;
            proto.get(fileLink.href, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        });

        // Parse VCF
        const contacts = parseVCF(vcfContent);

        if (contacts.length === 0) {
            session.waitingVcf = false;
            return await ctx.reply(
                `❌ Tidak ada kontak/nomor yang berhasil dibaca dari file ini.\n\n` +
                `Pastikan file VCF berisi nomor telepon yang valid.`
            );
        }

        // Simpan state import
        session.waitingVcf = false;
        const groupId   = session.vcfTargetGroupId;
        const groupName = session.vcfTargetGroupName;

        vcfImportState.set(userId, {
            groupId,
            groupName,
            contacts,
            offset: 0,
        });

        // Preview kontak
        const preview = contacts.slice(0, 5).map((c, i) =>
            `${i + 1}. ${c.name} (+${c.phone})`
        ).join('\n');
        const more = contacts.length > 5 ? `\n...dan ${contacts.length - 5} kontak lainnya` : '';

        await ctx.reply(
            `✅ File VCF Berhasil Dibaca\n${LINE}\n\n` +
            `Total kontak : ${contacts.length} nomor\n` +
            `Grup tujuan  : ${groupName}\n\n` +
            `Preview (5 pertama):\n${preview}${more}\n\n` +
            `${LINE}\n\n` +
            `Pilih metode penambahan:`,
            Markup.inlineKeyboard([
                [Markup.button.callback(`➕ Tambahkan Semua (${contacts.length})`, 'vcf_add_all')],
                [Markup.button.callback('📦 Tambahkan per 5', 'vcf_add_batch')],
                [Markup.button.callback('❌ Batal', 'vcf_cancel')]
            ])
        );
    } catch (err) {
        session.waitingVcf = false;
        await ctx.reply(`❌ Gagal proses file: ${err.message}`);
    }
});

// ── Tambahkan SEMUA kontak sekaligus ─────────────────
tgBot.action('vcf_add_all', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state  = vcfImportState.get(userId);
    const session = userSessions.get(userId);

    if (!state || !session?.loggedIn) {
        return await ctx.reply('❌ State expired. Ulangi /importvcf');
    }

    const { groupId, groupName, contacts } = state;
    const total = contacts.length;

    const progressMsg = await ctx.reply(
        `⏳ Menambahkan ${total} kontak ke "${groupName}"...\n\nProses ini mungkin butuh beberapa menit.`
    );

    let ok = 0, fail = 0, noWa = 0;
    const failList = [];
    const BATCH = 5; // WA batasi add per batch

    for (let i = 0; i < contacts.length; i += BATCH) {
        const batch = contacts.slice(i, i + BATCH);
        const jids  = batch.map(c => `${c.phone}@s.whatsapp.net`);

        try {
            const result = await session.sock.groupParticipantsUpdate(groupId, jids, 'add');

            // Proses hasil per nomor
            if (Array.isArray(result)) {
                result.forEach((r, idx) => {
                    if (r.status === '200') ok++;
                    else if (r.status === '408' || r.status === '403') {
                        noWa++;
                    } else {
                        fail++;
                        failList.push(`• ${batch[idx]?.phone}: status ${r.status}`);
                    }
                });
            } else {
                ok += batch.length;
            }
        } catch (err) {
            fail += batch.length;
            batch.forEach(c => failList.push(`• ${c.phone}: ${err.message}`));
        }

        // Update progress setiap 20 kontak
        if ((i + BATCH) % 20 === 0 || i + BATCH >= contacts.length) {
            const done = Math.min(i + BATCH, contacts.length);
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    progressMsg.message_id,
                    undefined,
                    `⏳ Progress: ${done}/${total} kontak diproses...`
                );
            } catch (_) {}
        }

        // Delay antar batch agar tidak dibanned WA
        if (i + BATCH < contacts.length) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    vcfImportState.delete(userId);

    let result = `Hasil Import VCF\n${LINE}\n\n` +
        `Grup       : ${groupName}\n` +
        `Total VCF  : ${total} kontak\n\n` +
        `✅ Berhasil   : ${ok} orang\n` +
        `⚠️ Tidak ada WA: ${noWa} orang\n` +
        `❌ Gagal      : ${fail} orang`;
    if (failList.length > 0) {
        result += `\n\nDetail gagal (maks 10):\n${failList.slice(0, 10).join('\n')}`;
    }
    result += `\n\n${LINE}\nKetik /kickmenu untuk kelola anggota grup.`;

    await ctx.reply(result);
});

// ── Tambahkan per batch 5 (manual, satu-satu) ────────
tgBot.action('vcf_add_batch', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state  = vcfImportState.get(userId);
    if (!state) return await ctx.reply('❌ State expired. Ulangi /importvcf');
    await doVcfBatch(ctx, userId, state);
});

tgBot.action('vcf_next_batch', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state  = vcfImportState.get(userId);
    if (!state) return await ctx.reply('❌ State expired. Ulangi /importvcf');
    await doVcfBatch(ctx, userId, state);
});

async function doVcfBatch(ctx, userId, state) {
    const session = userSessions.get(userId);
    if (!session?.loggedIn) return await ctx.reply('❌ Session WA expired. Ketik /login ulang.');

    const { groupId, groupName, contacts } = state;
    const BATCH  = 5;
    const offset = state.offset;
    const batch  = contacts.slice(offset, offset + BATCH);

    if (batch.length === 0) {
        vcfImportState.delete(userId);
        return await ctx.reply(`✅ Semua kontak sudah diproses!\n\nKetik /kickmenu untuk cek anggota grup.`);
    }

    const jids = batch.map(c => `${c.phone}@s.whatsapp.net`);
    await ctx.reply(`⏳ Menambahkan ${batch.length} kontak (${offset + 1}–${offset + batch.length} dari ${contacts.length})...`);

    let ok = 0, fail = 0, noWa = 0;
    try {
        const result = await session.sock.groupParticipantsUpdate(groupId, jids, 'add');
        if (Array.isArray(result)) {
            result.forEach(r => {
                if (r.status === '200') ok++;
                else if (r.status === '408' || r.status === '403') noWa++;
                else fail++;
            });
        } else { ok = batch.length; }
    } catch (err) {
        fail = batch.length;
    }

    state.offset += BATCH;
    const remaining = contacts.length - state.offset;

    let msg = `Batch ${Math.ceil(offset / BATCH) + 1} Selesai\n${LINE}\n\n` +
        `✅ Berhasil      : ${ok}\n` +
        `⚠️ Tidak ada WA : ${noWa}\n` +
        `❌ Gagal         : ${fail}\n\n` +
        `Sisa kontak     : ${remaining}`;

    if (remaining > 0) {
        await ctx.reply(msg,
            Markup.inlineKeyboard([
                [Markup.button.callback(`➡️ Lanjut ${Math.min(BATCH, remaining)} kontak berikutnya`, 'vcf_next_batch')],
                [Markup.button.callback('✅ Selesai', 'vcf_cancel')]
            ])
        );
    } else {
        vcfImportState.delete(userId);
        msg += `\n\n✅ Semua kontak selesai diproses!\nKetik /kickmenu untuk cek anggota.`;
        await ctx.reply(msg);
    }
}

tgBot.action('vcf_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    vcfImportState.delete(ctx.from.id);
    const session = userSessions.get(ctx.from.id);
    if (session) session.waitingVcf = false;
    await ctx.reply('ℹ️ Import kontak dibatalkan.');
});

// ╔══════════════════════════════════════════════════════════════╗
//   CALLBACKS
// ╚══════════════════════════════════════════════════════════════╝
tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!checkAccess(userId).ok && !isAdmin(userId)) return await ctx.answerCbQuery('⛔ Akses tidak aktif.');

    const jid     = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return await ctx.answerCbQuery('Session expired. Ketik /kickmenu lagi.');

    const selected = kickSelections.get(userId);
    selected.has(jid) ? selected.delete(jid) : selected.add(jid);
    await ctx.answerCbQuery(selected.has(jid) ? '✅ Dipilih' : '○ Dibatalkan');

    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId   = ctx.from.id;
    const session  = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    await ctx.answerCbQuery();

    if (!checkAccess(userId).ok && !isAdmin(userId)) return await ctx.reply('⛔ Akses tidak aktif.');
    if (!session?.loggedIn) return await ctx.reply('❌ Session WA expired. Ketik /login ulang.');
    if (!selected?.size)    return await ctx.reply('⚠️ Belum ada yang dipilih!');

    const jidList = Array.from(selected);
    await ctx.reply(`⏳ Mengkick ${jidList.length} anggota...`);

    let ok = 0, fail = 0;
    const failList = [];
    for (const jid of jidList) {
        try {
            await session.sock.groupParticipantsUpdate(session.groupId, [jid], 'remove');
            ok++;
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            fail++;
            failList.push(`• ${jid.split('@')[0]}: ${err.message}`);
        }
    }

    kickSelections.set(userId, new Set());
    let result = `Hasil Kick\n${LINE}\n\nBerhasil : ${ok} orang\nGagal    : ${fail} orang`;
    if (failList.length) result += `\n\nDetail gagal:\n${failList.join('\n')}`;
    result += `\n\n${LINE}\nKetik /kickmenu untuk kick lagi.`;
    await ctx.reply(result);
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('ℹ️ Kick dibatalkan.');
    try { await ctx.deleteMessage(); } catch (_) {}
});

// ╔══════════════════════════════════════════════════════════════╗
//   CRON — Cek expired setiap jam
// ╚══════════════════════════════════════════════════════════════╝
setInterval(() => {
    const db  = loadDB();
    const now = new Date();
    let changed = false;

    Object.values(db.users).forEach(user => {
        if (user.status !== 'active') return;
        const isTrialExp  = user.plan === 'trial'   && user.trialEnd && new Date(user.trialEnd) < now;
        const isSubExp    = user.plan === 'reguler' && user.subEnd   && new Date(user.subEnd)   < now;

        if (isTrialExp || isSubExp) {
            db.users[String(user.id)].status = 'expired';
            changed = true;
            const msg = isTrialExp
                ? `⏰ Trial kamu sudah habis.\n\nKetik /beli untuk berlangganan.`
                : `⏰ Langganan kamu sudah habis.\n\nKetik /beli untuk perpanjang.`;
            tgBot.telegram.sendMessage(user.id, msg).catch(() => {});
        }

        // Notif H-1 sebelum expired (reguler)
        if (user.plan === 'reguler' && user.subEnd && !user._notifH1) {
            const sisa = new Date(user.subEnd) - now;
            if (sisa > 0 && sisa < 25 * 3600000) {
                db.users[String(user.id)]._notifH1 = true;
                changed = true;
                tgBot.telegram.sendMessage(user.id,
                    `⚠️ Langganan kamu akan habis dalam kurang dari 24 jam!\n\nKetik /beli untuk perpanjang.`
                ).catch(() => {});
            }
        }
    });

    if (changed) saveDB(db);
}, 3600000);

// ╔══════════════════════════════════════════════════════════════╗
//   REPLY KEYBOARD — Tombol menu besar di atas keyboard
// ╚══════════════════════════════════════════════════════════════╝

// Helper: kirim keyboard yang sesuai role user
async function sendMenuKeyboard(ctx, userId) {
    if (isAdmin(userId)) {
        await ctx.reply('Menu admin aktif.', KEYBOARD_ADMIN);
        return;
    }
    const access  = checkAccess(userId);
    const session = userSessions.get(userId);
    if (!access.ok) {
        await ctx.reply('Silakan daftar atau beli paket untuk menggunakan bot.', KEYBOARD_GUEST);
        return;
    }
    if (session?.loggedIn) {
        await ctx.reply('Menu siap digunakan.', KEYBOARD_USER_LOGGEDIN);
    } else {
        await ctx.reply('Login WA untuk mengakses semua fitur.', KEYBOARD_USER);
    }
}

// ╔══════════════════════════════════════════════════════════════╗
//   HANDLER TOMBOL KEYBOARD — Tangkap teks tombol & jalankan
// ╚══════════════════════════════════════════════════════════════╝
tgBot.hears('📱 Login WA',       (ctx) => ctx.scene ? null : tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/login',     entities: [{ offset: 0, length: 6,  type: 'bot_command' }] } }));
tgBot.hears('🔌 Logout WA',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/logout',    entities: [{ offset: 0, length: 7,  type: 'bot_command' }] } }));
tgBot.hears('📡 Status',         (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/status',    entities: [{ offset: 0, length: 7,  type: 'bot_command' }] } }));
tgBot.hears('📋 Daftar Grup',    (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/groups',    entities: [{ offset: 0, length: 7,  type: 'bot_command' }] } }));
tgBot.hears('🔴 Kick Menu',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/kickmenu',  entities: [{ offset: 0, length: 9,  type: 'bot_command' }] } }));
tgBot.hears('🆕 Buat Grup',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/buatgrup',  entities: [{ offset: 0, length: 9,  type: 'bot_command' }] } }));
tgBot.hears('📥 Import VCF',     (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/importvcf', entities: [{ offset: 0, length: 10, type: 'bot_command' }] } }));
tgBot.hears('💰 Paket Saya',     (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/myplan',    entities: [{ offset: 0, length: 7,  type: 'bot_command' }] } }));
tgBot.hears('💎 Upgrade',        (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/beli',      entities: [{ offset: 0, length: 5,  type: 'bot_command' }] } }));
tgBot.hears('💎 Lihat Paket',    (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/beli',      entities: [{ offset: 0, length: 5,  type: 'bot_command' }] } }));
tgBot.hears('📊 Info Akun',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/myplan',    entities: [{ offset: 0, length: 7,  type: 'bot_command' }] } }));
tgBot.hears('👥 User List',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/userlist',  entities: [{ offset: 0, length: 9,  type: 'bot_command' }] } }));
tgBot.hears('🛒 Pending',        (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/pending',   entities: [{ offset: 0, length: 8,  type: 'bot_command' }] } }));
tgBot.hears('📈 Statistik',      (ctx) => tgBot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/stats',     entities: [{ offset: 0, length: 6,  type: 'bot_command' }] } }));
tgBot.hears('🎁 Mulai Trial Gratis', async (ctx) => {
    const userId = ctx.from.id;
    const existing = getUser(userId);
    if (existing) return await ctx.reply(`❌ Kamu sudah pernah mendaftar.\n\nKetik /myplan untuk cek status.`);
    // Trigger action start_trial
    const now      = new Date();
    const trialEnd = new Date(now.getTime() + CONFIG.TRIAL_HOURS * 3600000);
    const name     = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Tanpa nama';
    const uname    = ctx.from.username ? '@' + ctx.from.username : '-';
    upsertUser(userId, {
        id: userId, username: ctx.from.username || null,
        firstName: ctx.from.first_name || '', lastName: ctx.from.last_name || '',
        plan: 'trial', status: 'active',
        trialStart: now.toISOString(), trialEnd: trialEnd.toISOString(),
        maxGroups: CONFIG.TRIAL_MAX_GROUPS, createdAt: now.toISOString(),
    });
    for (const adminId of CONFIG.ADMIN_IDS) {
        try { await tgBot.telegram.sendMessage(adminId, `🔔 USER BARU — TRIAL\n\nNama  : ${name}\nUser  : ${uname}\nID    : ${userId}\nHabis : ${formatDate(trialEnd.toISOString())}`); } catch (_) {}
    }
    await ctx.reply(
        `🎉 Trial Aktif!\n${LINE}\n\nDurasi : ${CONFIG.TRIAL_HOURS} jam\nHabis  : ${formatDate(trialEnd.toISOString())}\n\n${LINE}\n\nMulai dengan /login untuk menghubungkan WhatsApp.`,
        KEYBOARD_USER
    );
});

tgBot.hears('🎯 Pilih Grup', async (ctx) => {
    const session = userSessions.get(ctx.from.id);
    if (!session?.loggedIn) return await ctx.reply('❌ Login WA dulu! Ketuk tombol 📱 Login WA');
    await ctx.reply(
        `Pilih Grup Aktif\n${LINE}\n\n` +
        `Format: /select Nama Grup\n\n` +
        `Atau ketuk tombol 📋 Daftar Grup untuk lihat semua grup.`
    );
});

tgBot.hears('❓ Bantuan', async (ctx) => {
    const userId = ctx.from.id;
    const access = checkAccess(userId);
    await ctx.reply(
        `Bantuan ${CONFIG.BOT_NAME}\n${LINE}\n\n` +
        `Cara pakai bot:\n\n` +
        `1. Ketuk 📱 Login WA → scan QR\n` +
        `2. Ketuk 📋 Daftar Grup → lihat grup\n` +
        `3. /select Nama Grup → pilih grup\n` +
        `4. Ketuk 🔴 Kick Menu → kick anggota\n` +
        `5. Ketuk 🆕 Buat Grup → buat grup baru\n` +
        `6. Ketuk 📥 Import VCF → import kontak\n\n` +
        `${LINE}\n\n` +
        (!access.ok ? `Belum punya akses? Ketuk 🎁 Mulai Trial Gratis\n\n` : '') +
        `Masalah? Hubungi admin.`
    );
});

// ╔══════════════════════════════════════════════════════════════╗
//   UPDATE /start — Tampilkan keyboard saat /start
// ╚══════════════════════════════════════════════════════════════╝
// Inject keyboard ke semua respons /start
// Caranya: tambah sendMenuKeyboard SETELAH tiap blok reply /start
// Kita override dengan middleware on('text') yang tangkap /start setelah handler utama
// LEBIH SIMPEL: tambahkan keyboard langsung ke reply /start yang sudah ada
// Tapi karena handler /start sudah panjang, kita pakai pendekatan middleware:

tgBot.use(async (ctx, next) => {
    await next();
    // Setelah setiap pesan dari user, kalau mereka belum punya keyboard → kirim
    // Cukup kirim keyboard saat /start saja — sudah ditangani di handler /start di atas
    // Middleware ini kosong, keyboard dikirim langsung di handler masing-masing
});

// ╔══════════════════════════════════════════════════════════════╗
//   LAUNCH
// ╚══════════════════════════════════════════════════════════════╝
tgBot.launch().then(async () => {
    console.log('╔══════════════════════════════════╗');
    console.log(`║  ${CONFIG.BOT_NAME} — AKTIF           ║`);
    console.log('╠══════════════════════════════════╣');
    console.log(`║  Admin   : ${CONFIG.ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial   : ${CONFIG.TRIAL_HOURS} jam`);
    console.log(`║  DB File : ${CONFIG.DATA_FILE}`);
    console.log('╚══════════════════════════════════╝');

    // ── Set daftar perintah di menu "/" Telegram ──────────────
    // Perintah ini muncul saat user ketuk "/" di keyboard Telegram
    try {
        // Perintah untuk user biasa
        await tgBot.telegram.setMyCommands([
            { command: 'start',     description: '🏠 Menu utama' },
            { command: 'login',     description: '📱 Login WhatsApp' },
            { command: 'logout',    description: '🔌 Logout WhatsApp' },
            { command: 'status',    description: '📡 Cek status koneksi' },
            { command: 'groups',    description: '📋 Lihat daftar grup' },
            { command: 'select',    description: '🎯 Pilih grup aktif' },
            { command: 'kickmenu',  description: '🔴 Kick anggota grup' },
            { command: 'buatgrup',  description: '🆕 Buat grup WA baru' },
            { command: 'importvcf', description: '📥 Import kontak dari VCF' },
            { command: 'myplan',    description: '💰 Info paket saya' },
            { command: 'beli',      description: '💎 Lihat & beli paket' },
            { command: 'order',     description: '🛒 Order paket' },
            { command: 'refreshqr', description: '🔄 Refresh QR code' },
        ], { scope: { type: 'all_private_chats' } });

        // Perintah tambahan khusus admin
        // Dikirim per admin ID
        for (const adminId of CONFIG.ADMIN_IDS) {
            try {
                await tgBot.telegram.setMyCommands([
                    { command: 'start',     description: '🏠 Menu utama' },
                    { command: 'login',     description: '📱 Login WhatsApp' },
                    { command: 'logout',    description: '🔌 Logout WhatsApp' },
                    { command: 'status',    description: '📡 Status koneksi' },
                    { command: 'groups',    description: '📋 Daftar grup' },
                    { command: 'select',    description: '🎯 Pilih grup' },
                    { command: 'kickmenu',  description: '🔴 Kick anggota' },
                    { command: 'buatgrup',  description: '🆕 Buat grup baru' },
                    { command: 'importvcf', description: '📥 Import VCF' },
                    { command: 'myplan',    description: '💰 Info paket' },
                    { command: 'beli',      description: '💎 Beli paket' },
                    { command: 'pending',   description: '🛒 Antrian order' },
                    { command: 'userlist',  description: '👥 Daftar user' },
                    { command: 'addtrial',  description: '🎁 Beri trial [id]' },
                    { command: 'addsub',    description: '✅ Aktifkan sub [id] [paket]' },
                    { command: 'revoke',    description: '🚫 Cabut akses [id]' },
                    { command: 'ban',       description: '⛔ Blokir user [id]' },
                    { command: 'cekuser',   description: '🔍 Detail user [id]' },
                    { command: 'stats',     description: '📈 Statistik bot' },
                    { command: 'refreshqr', description: '🔄 Refresh QR' },
                ], { scope: { type: 'chat', chat_id: adminId } });
            } catch (_) {}
        }

        console.log('✅ Bot commands berhasil diset');
    } catch (err) {
        console.log('⚠️  Gagal set commands:', err.message);
    }
});

process.on('SIGINT',  () => { tgBot.stop('SIGINT');  process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });
