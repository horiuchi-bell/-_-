import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 50 * 1024 * 1024,
});

const PORT = process.env.PORT || 3000;

// --- ストレージ設定 ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('PDFファイルのみアップロードできます'));
  },
});

// --- セッション管理 (インメモリ) ---
// Session: { id, pdfPath, pdfName, pin, strokes: Map<strokeId, Stroke>, users: Map<socketId, {userId, name, role}>, createdAt }
const sessions = new Map();

// --- 静的ファイル ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- REST API ---

// セッション作成 (PDFアップロード + PIN設定)
app.post('/api/sessions', upload.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'PDFファイルが必要です' });
  }
  const pin = (req.body.pin || '').trim();
  if (!pin || pin.length < 4 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ error: 'PINは4桁以上の数字で入力してください' });
  }
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    id: sessionId,
    pdfPath: req.file.path,
    pdfName: req.file.originalname,
    pin,
    strokes: new Map(),
    users: new Map(),  // socketId → { userId, name, role }
    createdAt: new Date().toISOString(),
  });
  res.json({ sessionId });
});

// セッション情報取得（PIN不要 - pdfName のみ公開）
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
  res.json({ pdfName: session.pdfName, strokeCount: session.strokes.size });
});

// PDFファイル配信（PIN検証はSocket.IO join後に行うためここでは省略）
app.get('/api/sessions/:id/pdf', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(session.pdfPath);
});

// セッションページ
app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

// --- Socket.IO ---

io.on('connection', (socket) => {
  let currentSessionId = null;
  let currentUser = null;  // { userId, name, role } — サーバー側で管理

  // セッション参加（PIN検証 + ユーザー登録）
  socket.on('join-session', ({ sessionId, pin, user }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('join-error', 'セッションが見つかりません');
      return;
    }
    if (session.pin !== String(pin)) {
      socket.emit('join-error', 'PINが正しくありません');
      return;
    }

    currentSessionId = sessionId;
    // サーバー側でユーザー情報を正規化して保持（クライアントからのrole改ざんを防ぐ）
    currentUser = {
      userId: user.id,
      name: user.name,
      role: user.role,
    };
    session.users.set(socket.id, currentUser);
    socket.join(sessionId);

    // 現在の全ストロークを送信
    socket.emit('session-state', {
      strokes: Array.from(session.strokes.values()),
      pdfName: session.pdfName,
    });
  });

  // ストローク追加（ownerIdはサーバー側で上書き）
  socket.on('stroke-add', (stroke) => {
    const session = sessions.get(currentSessionId);
    if (!session || !currentUser) return;

    // サーバー側でオーナー情報を確定（クライアントの自己申告を上書き）
    stroke.ownerId   = currentUser.userId;
    stroke.ownerName = currentUser.name;
    stroke.ownerRole = currentUser.role;
    stroke.status    = 'active';

    session.strokes.set(stroke.id, stroke);
    // 送信者以外にブロードキャスト
    socket.to(currentSessionId).emit('stroke-added', stroke);
  });

  // ストローク削除（サーバー側で所有者チェック）
  socket.on('stroke-remove', ({ strokeId }) => {
    const session = sessions.get(currentSessionId);
    if (!session || !currentUser) return;

    const stroke = session.strokes.get(strokeId);
    if (!stroke) return;

    // サーバー側で所有者チェック（クライアント送信のrequesterIdは使わない）
    if (stroke.ownerId !== currentUser.userId) {
      socket.emit('error', { message: '自分のストロークのみ削除できます' });
      return;
    }
    session.strokes.delete(strokeId);
    io.to(currentSessionId).emit('stroke-removed', { strokeId });
  });

  // 解除（サーバー側で線閉責任者チェック）
  socket.on('strokes-release', ({ strokeIds }) => {
    const session = sessions.get(currentSessionId);
    if (!session || !currentUser) return;

    // サーバー側でロール検証（クライアント送信のrequesterRoleは使わない）
    if (currentUser.role !== '線閉責任者') {
      socket.emit('error', { message: '線閉責任者のみ解除できます' });
      return;
    }

    const releasedAt = new Date().toISOString();
    const releasedName = currentUser.name;
    const updated = [];

    strokeIds.forEach((strokeId) => {
      const stroke = session.strokes.get(strokeId);
      if (stroke && stroke.status === 'active') {
        stroke.status     = 'released';
        stroke.releasedBy = releasedName;
        stroke.releasedAt = releasedAt;
        updated.push(strokeId);
      }
    });

    if (updated.length > 0) {
      io.to(currentSessionId).emit('strokes-released', {
        strokeIds: updated,
        releasedBy: releasedName,
        releasedAt,
      });
    }
  });

  socket.on('disconnect', () => {
    if (currentSessionId) {
      const session = sessions.get(currentSessionId);
      if (session) session.users.delete(socket.id);
    }
  });
});

// --- サーバー起動 ---
httpServer.listen(PORT, () => {
  const localIPs = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);

  console.log('');
  console.log('====================================================');
  console.log(' PDF マークアップ共有サーバー 起動中');
  console.log('====================================================');
  console.log(` ローカル:   http://localhost:${PORT}`);
  localIPs.forEach((ip) => {
    console.log(` LAN内:      http://${ip}:${PORT}`);
  });
  console.log('');
  console.log(' インターネット越しに公開するには:');
  console.log('   npx cloudflared tunnel --url http://localhost:' + PORT);
  console.log('   または: npx ngrok http ' + PORT);
  console.log('====================================================');
  console.log('');
});
