require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { Server } = require('socket.io');

const User = require('./models/User');
const FriendRequest = require('./models/FriendRequest');
const Message = require('./models/Message');
const Post = require('./models/Post');

const app = express();
const server = http.createServer(app);
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 4000;
const mongoUri =
  process.env.MONGO_URI?.trim() ||
  (isProduction ? '' : 'mongodb://127.0.0.1:27017/socialgram');
const jwtSecret =
  process.env.JWT_SECRET?.trim() ||
  (isProduction ? '' : 'change_this');
const clientUrls = (process.env.CLIENT_URL || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const uploadDir = path.resolve(__dirname, process.env.UPLOAD_DIR?.trim() || 'uploads');
const frontendDistDir = path.resolve(__dirname, '../frontend/dist');
const frontendIndexFile = path.join(frontendDistDir, 'index.html');

if (!mongoUri) {
  throw new Error('MONGO_URI is required in production');
}

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required in production');
}

if (isProduction && jwtSecret === 'change_this') {
  throw new Error('JWT_SECRET must be set to a strong value in production');
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function isLocalDevOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch (e) {
    return false;
  }
}

function isAllowedOrigin(origin, sameOrigin) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (sameOrigin && normalized === sameOrigin) return true;
  if (clientUrls.includes(normalized)) return true;
  if (!isProduction && isLocalDevOrigin(normalized)) return true;
  return clientUrls.length === 0;
}

function corsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) return callback(null, true);
  return callback(new Error('Not allowed by CORS'));
}

function apiCorsOptions(req, callback) {
  const requestOrigin = normalizeOrigin(`${req.protocol}://${req.get('host')}`);
  const origin = req.header('Origin');

  if (isAllowedOrigin(origin, requestOrigin)) {
    return callback(null, {
      origin: true,
      credentials: true,
    });
  }

  return callback(new Error('Not allowed by CORS'));
}

const corsOptions =
  clientUrls.length > 0 || !isProduction
    ? {
        origin: corsOrigin,
        credentials: true,
      }
    : null;

const io = new Server(
  server,
  corsOptions
    ? {
        cors: {
          origin: corsOrigin,
          methods: ['GET', 'POST'],
          credentials: true,
        },
      }
    : undefined
);

app.set('trust proxy', 1);
app.use(express.json());

app.use('/api', cors(apiCorsOptions));

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF, or WebP images are allowed'));
  },
});

function uploadImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 5MB or smaller'
        : err.message || 'Upload failed';
    return res.status(400).json({ error: msg });
  });
}

app.use('/uploads', express.static(uploadDir));

// 🔐 Auth Middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function safeUnlinkUpload(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('/uploads/')) return;
  const base = path.basename(imageUrl);
  if (!base || base === '.' || base === '..') return;
  const full = path.join(uploadDir, base);
  if (!full.startsWith(path.resolve(uploadDir))) return;
  fs.unlink(full, () => {});
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 🧾 Routes (Auth, Friends, Users, Messages)
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Missing fields' });

  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) return res.status(400).json({ error: 'User exists' });

  const pw = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email, passwordHash: pw });
  const token = jwt.sign({ id: user._id, username: user.username }, jwtSecret);
  res.json({
    token,
    user: { id: user._id, username: user.username, email: user.email },
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: 'Invalid' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid' });

  const token = jwt.sign({ id: user._id, username: user.username }, jwtSecret);
  res.json({ token, user: { id: user._id, username: user.username } });
});

app.get('/api/users/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id)
    .select('-passwordHash')
    .populate('friends', 'username avatarUrl');
  res.json(user);
});

app.delete('/api/friends/:friendId', auth, async (req, res) => {
  try {
    const friendId = req.params.friendId;
    if (String(friendId) === String(req.user.id))
      return res.status(400).json({ error: 'Invalid user' });

    const me = await User.findById(req.user.id).select('friends').lean();
    const isFriend = (me?.friends || []).some((id) => String(id) === String(friendId));
    if (!isFriend) return res.status(404).json({ error: 'Not friends with this user' });

    await User.findByIdAndUpdate(req.user.id, { $pull: { friends: friendId } });
    await User.findByIdAndUpdate(friendId, { $pull: { friends: req.user.id } });
    await FriendRequest.deleteMany({
      $or: [
        { from: req.user.id, to: friendId },
        { from: friendId, to: req.user.id },
      ],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not unfriend' });
  }
});

app.delete('/api/users/me', auth, async (req, res) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });

    const userId = user._id;

    const myPosts = await Post.find({ author: userId }).select('imageUrl').lean();
    for (const p of myPosts) safeUnlinkUpload(p.imageUrl);
    safeUnlinkUpload(user.avatarUrl);

    await Post.deleteMany({ author: userId });
    await Post.updateMany({}, { $pull: { likes: userId } });
    await Post.updateMany({}, { $pull: { comments: { author: userId } } });

    await FriendRequest.deleteMany({
      $or: [{ from: userId }, { to: userId }],
    });
    await Message.deleteMany({
      $or: [{ from: userId }, { to: userId }],
    });
    await User.updateMany({ friends: userId }, { $pull: { friends: userId } });

    await User.findByIdAndDelete(userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete account' });
  }
});

app.get('/api/users/search', auth, async (req, res) => {
  const q = req.query.q || '';
  const users = await User.find({
    username: { $regex: q, $options: 'i' },
  })
    .limit(20)
    .select('username avatarUrl bio');
  res.json(users);
});

// People to discover (Instagram-style explore / suggestions)
app.get('/api/users/explore', auth, async (req, res) => {
  try {
    const meId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 48, 1), 100);

    const me = await User.findById(meId).select('friends').lean();
    const friendIds = new Set((me?.friends || []).map((id) => String(id)));

    const pending = await FriendRequest.find({
      status: 'pending',
      $or: [{ from: meId }, { to: meId }],
    }).lean();

    const requestedTo = new Set();
    const requestedFrom = new Set();
    for (const fr of pending) {
      if (String(fr.from) === String(meId)) requestedTo.add(String(fr.to));
      else requestedFrom.add(String(fr.from));
    }

    const poolSize = Math.min(200, Math.max(limit * 4, limit));
    const meObjectId = new mongoose.Types.ObjectId(meId);
    const candidates = await User.aggregate([
      { $match: { _id: { $ne: meObjectId } } },
      { $sample: { size: poolSize } },
      { $project: { username: 1, avatarUrl: 1, bio: 1 } },
    ]);

    const order = { none: 0, requests_you: 1, requested_by_you: 2, friend: 3 };
    const shaped = candidates.map((u) => {
      const id = String(u._id);
      let relationship = 'none';
      if (friendIds.has(id)) relationship = 'friend';
      else if (requestedTo.has(id)) relationship = 'requested_by_you';
      else if (requestedFrom.has(id)) relationship = 'requests_you';
      return { ...u, relationship };
    });

    shaped.sort((a, b) => {
      const d = order[a.relationship] - order[b.relationship];
      if (d !== 0) return d;
      return (a.username || '').localeCompare(b.username || '');
    });

    res.json(shaped.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: 'Could not load explore' });
  }
});

app.post('/api/requests/send', auth, async (req, res) => {
  const { toUserId } = req.body;
  if (req.user.id === toUserId)
    return res.status(400).json({ error: 'Cannot send to yourself' });

  try {
    const fr = await FriendRequest.create({ from: req.user.id, to: toUserId });
    res.json(fr);
  } catch (e) {
    res.status(400).json({ error: 'Request exists or bad' });
  }
});

app.post('/api/requests/:id/accept', auth, async (req, res) => {
  const fr = await FriendRequest.findById(req.params.id);
  if (!fr) return res.status(404).json({ error: 'Not found' });
  if (String(fr.to) !== req.user.id)
    return res.status(403).json({ error: 'Not allowed' });

  fr.status = 'accepted';
  await fr.save();
  await User.findByIdAndUpdate(fr.from, { $addToSet: { friends: fr.to } });
  await User.findByIdAndUpdate(fr.to, { $addToSet: { friends: fr.from } });
  res.json({ ok: true });
});

app.post('/api/requests/:id/decline', auth, async (req, res) => {
  const fr = await FriendRequest.findById(req.params.id);
  if (!fr) return res.status(404).json({ error: 'Not found' });
  if (String(fr.to) !== req.user.id)
    return res.status(403).json({ error: 'Not allowed' });

  fr.status = 'declined';
  await fr.save();
  res.json({ ok: true });
});

app.get('/api/requests', auth, async (req, res) => {
  const incoming = await FriendRequest.find({
    to: req.user.id,
    status: 'pending',
  }).populate('from', 'username avatarUrl');
  const outgoing = await FriendRequest.find({
    from: req.user.id,
    status: 'pending',
  }).populate('to', 'username avatarUrl');
  res.json({ incoming, outgoing });
});

app.get('/api/messages/:conversationId', auth, async (req, res) => {
  const msgs = await Message.find({
    conversationId: req.params.conversationId,
  })
    .sort('createdAt')
    .limit(200);
  res.json(msgs);
});

// 📸 Posts (feed, upload, likes, comments)
app.get('/api/posts/feed', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select('friends').lean();
    const friendIds = (me?.friends || []).map((id) => String(id));
    const authorIds = [String(req.user.id), ...friendIds];
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const posts = await Post.find({ author: { $in: authorIds } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('author', 'username avatarUrl')
      .populate('comments.author', 'username avatarUrl')
      .lean();

    const uid = String(req.user.id);
    const shaped = posts.map((p) => ({
      ...p,
      likeCount: (p.likes || []).length,
      likedByMe: (p.likes || []).some((id) => String(id) === uid),
      likes: undefined,
    }));

    res.json(shaped);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

app.post('/api/posts', auth, uploadImage, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image is required' });
    const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : '';
    const imageUrl = `/uploads/${req.file.filename}`;
    const post = await Post.create({
      author: req.user.id,
      caption,
      imageUrl,
    });
    await post.populate('author', 'username avatarUrl');
    const doc = post.toObject();
    res.status(201).json({
      ...doc,
      likeCount: 0,
      likedByMe: false,
      likes: undefined,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not create post' });
  }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const idx = post.likes.findIndex((id) => String(id) === String(req.user.id));
    let likedByMe;
    if (idx >= 0) {
      post.likes.splice(idx, 1);
      likedByMe = false;
    } else {
      post.likes.push(req.user.id);
      likedByMe = true;
    }
    await post.save();
    res.json({ likeCount: post.likes.length, likedByMe });
  } catch (e) {
    res.status(500).json({ error: 'Could not update like' });
  }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Comment text is required' });

    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    post.comments.push({ author: req.user.id, text });
    await post.save();

    const fresh = await Post.findById(post._id)
      .populate({ path: 'comments.author', select: 'username avatarUrl' })
      .lean();

    const last = fresh.comments[fresh.comments.length - 1];
    res.status(201).json(last);
  } catch (e) {
    res.status(500).json({ error: 'Could not add comment' });
  }
});

// 🧠 Socket.io logic
const online = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    const payload = jwt.verify(token, jwtSecret);
    socket.user = payload;
    next();
  } catch (e) {
    next(new Error('Auth error'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  online.set(userId, socket.id);

  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
  });

  socket.on('sendMessage', async (data) => {
    const message = await Message.create({
      conversationId: data.conversationId,
      from: userId,
      to: data.to,
      text: data.text,
    });
    io.to(data.conversationId).emit('message', message);

    const toSocket = online.get(String(data.to));
    if (toSocket)
      io.to(toSocket).emit('new_message_notification', {
        from: userId,
        conversationId: data.conversationId,
      });
  });

  socket.on('disconnect', () => {
    online.delete(userId);
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (fs.existsSync(frontendIndexFile)) {
  app.use(express.static(frontendDistDir));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/uploads/')) return next();
    if (!req.accepts('html')) return next();
    return res.sendFile(frontendIndexFile);
  });
}

app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error(err);

  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: 'Server error' });
  }

  return res.status(500).send('Server error');
});

async function startServer() {
  try {
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB Connected');
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Startup error:', err);
    process.exit(1);
  }
}

startServer();
