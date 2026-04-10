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
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB
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
// sessions: Map<sessionId, Session>
// Session: { id, pdfPath, pdfName, strokes: Map<strokeId, Stroke>, createdAt }
const sessions = new Map();

// --- 静的ファイル ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- REST API ---

// セッション作成 (PDFアップロード)
app.post('/api/sessions', upload.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'PDFファイルが必要です' });
  }
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    id: sessionId,
    pdfPath: req.file.path,
    pdfName: req.file.originalname,
    strokes: new Map(),
    createdAt: new Date().toISOString(),
  });
  res.json({ sessionId });
});

// セッション情報取得
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
  res.json({ pdfName: session.pdfName, strokeCount: session.strokes.size });
});

// PDFファイル配信
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
  let currentUser = null;

  // セッション参加
  socket.on('join-session', ({ sessionId, user }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', { message: 'セッションが見つかりません' });
      return;
    }
    currentSessionId = sessionId;
    currentUser = user;
    socket.join(sessionId);

    // 現在の全ストロークを送信
    socket.emit('session-state', {
      strokes: Array.from(session.strokes.values()),
      pdfName: session.pdfName,
    });
  });

  // ストローク追加
  socket.on('stroke-add', (stroke) => {
    const session = sessions.get(currentSessionId);
    if (!session) return;
    session.strokes.set(stroke.id, stroke);
    // 送信者以外にブロードキャスト
    socket.to(currentSessionId).emit('stroke-added', stroke);
  });

  // ストローク削除 (自分のストロークのみ)
  socket.on('stroke-remove', ({ strokeId, requesterId }) => {
    const session = sessions.get(currentSessionId);
    if (!session) return;
    const stroke = session.strokes.get(strokeId);
    if (!stroke) return;
    // 所有者チェック
    if (stroke.ownerId !== requesterId) {
      socket.emit('error', { message: '自分のストロークのみ削除できます' });
      return;
    }
    session.strokes.delete(strokeId);
    io.to(currentSessionId).emit('stroke-removed', { strokeId });
  });

  // 解除 (線閉責任者のみ: status を released に変更)
  socket.on('strokes-release', ({ strokeIds, requesterId, requesterRole }) => {
    if (requesterRole !== '線閉責任者') {
      socket.emit('error', { message: '線閉責任者のみ解除できます' });
      return;
    }
    const session = sessions.get(currentSessionId);
    if (!session) return;
    const releasedAt = new Date().toISOString();
    const releasedName = currentUser ? currentUser.name : '不明';
    strokeIds.forEach((strokeId) => {
      const stroke = session.strokes.get(strokeId);
      if (stroke) {
        stroke.status = 'released';
        stroke.releasedBy = releasedName;
        stroke.releasedAt = releasedAt;
      }
    });
    io.to(currentSessionId).emit('strokes-released', {
      strokeIds,
      releasedBy: releasedName,
      releasedAt,
    });
  });

  socket.on('disconnect', () => {
    // 将来的にユーザーリスト表示などに使用
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
