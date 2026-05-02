import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";
import {
  addContact,
  addReaction,
  blockUser,
  createChat,
  createMessage,
  createSession,
  createUser,
  deleteSession,
  findOrCreateDirectChat,
  getChatById,
  getChatMessages,
  getSessionUser,
  getUserById,
  getUserWithPasswordByIdentifier,
  initializeDatabase,
  listContacts,
  listReactionsByMessageIds,
  listUserChats,
  reportUser,
  searchUsers,
  searchWorkspace,
  touchLastSeen,
  updateChatReadPointer,
  updateMessageStatus,
  updateUserProfile,
  verifyPassword
} from "./db.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 4000);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";

app.use(
  cors({
    origin: clientUrl,
    credentials: true
  })
);
app.use(express.json({ limit: "10mb" }));

const io = new Server(server, {
  cors: {
    origin: clientUrl
  }
});

const onlineUsers = new Map();
const socketUsers = new Map();
const chatTyping = new Map();

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  return req.query.token || "";
}

async function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ message: "Authentication required." });
      return;
    }

    const user = await getSessionUser(token);
    if (!user) {
      res.status(401).json({ message: "Session expired or invalid." });
      return;
    }

    req.token = token;
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ message: "Authentication failed." });
  }
}

function getOnlineCount() {
  return onlineUsers.size;
}

function getPublicPresence(userId) {
  const count = onlineUsers.get(userId) || 0;
  return {
    userId,
    isOnline: count > 0
  };
}

function emitPresence(userId) {
  io.emit("presence:user", getPublicPresence(userId));
  io.emit("presence:summary", { onlineCount: getOnlineCount() });
}

async function emitChatSnapshot(chatId, userIdForView) {
  const chat = await getChatById(chatId, userIdForView);
  if (!chat) {
    return;
  }

  io.to(`chat:${chatId}`).emit("chat:updated", chat);
}

async function attachReactions(messages) {
  const reactions = await listReactionsByMessageIds(messages.map((message) => message.id));
  return messages.map((message) => ({
    ...message,
    reactions: reactions.filter((reaction) => reaction.messageId === message.id)
  }));
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Pulse Messaging Backend",
    status: "running",
    frontend: clientUrl,
    features: [
      "auth",
      "direct-messages",
      "group-chat",
      "presence",
      "typing",
      "read-receipts",
      "media-upload",
      "search",
      "contacts",
      "blocking",
      "reports",
      "reactions"
    ]
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim();

    if (!username || !password || !name || (!email && !phone)) {
      res.status(400).json({
        message: "Name, username, password, and email or phone are required."
      });
      return;
    }

    const user = await createUser({
      username,
      email,
      phone,
      password,
      name,
      avatarUrl: String(req.body.avatarUrl || "").trim(),
      about: String(req.body.about || "").trim(),
      customStatus: String(req.body.customStatus || "").trim()
    });
    const token = await createSession(user.id);

    res.status(201).json({ token, user });
  } catch (error) {
    res.status(400).json({
      message: error.message.includes("Duplicate")
        ? "That email, phone, or username is already in use."
        : "Unable to register user."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const identifier = String(req.body.identifier || "").trim();
    const password = String(req.body.password || "");

    const userRow = await getUserWithPasswordByIdentifier(identifier);
    if (!userRow || !verifyPassword(password, userRow.passwordHash)) {
      res.status(401).json({ message: "Invalid login credentials." });
      return;
    }

    const token = await createSession(userRow.id);
    const user = await getUserById(userRow.id);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ message: "Unable to log in." });
  }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  await deleteSession(req.token);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const chats = await listUserChats(req.user.id);
  const contacts = await listContacts(req.user.id);
  res.json({
    user: req.user,
    stats: {
      onlineCount: getOnlineCount()
    },
    chats,
    contacts
  });
});

app.patch("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await updateUserProfile(req.user.id, req.body);
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: "Could not update profile." });
  }
});

app.get("/api/users/search", requireAuth, async (req, res) => {
  const term = String(req.query.q || "").trim();
  if (!term) {
    res.json([]);
    return;
  }

  const users = await searchUsers(req.user.id, term);
  res.json(users);
});

app.post("/api/contacts", requireAuth, async (req, res) => {
  const contactUserId = Number(req.body.contactUserId);
  await addContact(req.user.id, contactUserId, String(req.body.aliasName || "").trim());
  res.json({ ok: true });
});

app.post("/api/blocks", requireAuth, async (req, res) => {
  const blockedUserId = Number(req.body.blockedUserId);
  await blockUser(req.user.id, blockedUserId, String(req.body.reason || "").trim());
  res.json({ ok: true });
});

app.post("/api/reports", requireAuth, async (req, res) => {
  await reportUser({
    reporterUserId: req.user.id,
    reportedUserId: Number(req.body.reportedUserId),
    chatId: req.body.chatId ? Number(req.body.chatId) : null,
    reason: String(req.body.reason || "").trim() || "unspecified",
    details: String(req.body.details || "").trim()
  });
  res.status(201).json({ ok: true });
});

app.get("/api/chats", requireAuth, async (req, res) => {
  const chats = await listUserChats(req.user.id);
  res.json(chats);
});

app.post("/api/chats/direct", requireAuth, async (req, res) => {
  try {
    const otherUserId = Number(req.body.userId);
    const chat = await findOrCreateDirectChat(req.user.id, otherUserId);
    res.status(201).json(chat);
  } catch (error) {
    res.status(400).json({ message: "Unable to open direct chat." });
  }
});

app.post("/api/chats/group", requireAuth, async (req, res) => {
  try {
    const chat = await createChat({
      type: "group",
      name: String(req.body.name || "").trim(),
      description: String(req.body.description || "").trim(),
      avatarUrl: String(req.body.avatarUrl || "").trim(),
      createdBy: req.user.id,
      memberIds: Array.isArray(req.body.memberIds) ? req.body.memberIds : []
    });
    res.status(201).json(chat);
  } catch (error) {
    res.status(400).json({ message: "Unable to create group chat." });
  }
});

app.get("/api/chats/:chatId", requireAuth, async (req, res) => {
  const chat = await getChatById(Number(req.params.chatId), req.user.id);
  if (!chat) {
    res.status(404).json({ message: "Chat not found." });
    return;
  }

  res.json(chat);
});

app.get("/api/chats/:chatId/messages", requireAuth, async (req, res) => {
  const messages = await getChatMessages(
    Number(req.params.chatId),
    req.user.id,
    Number(req.query.limit || 100)
  );
  res.json(await attachReactions(messages));
});

app.post("/api/chats/:chatId/messages", requireAuth, async (req, res) => {
  try {
    const attachmentMime = String(req.body.attachmentMime || "").trim();
    const attachmentType = req.body.attachmentDataUrl
      ? String(req.body.attachmentType || "").trim() || inferAttachmentType(attachmentMime)
      : null;
    const message = await createMessage({
      chatId: Number(req.params.chatId),
      senderId: req.user.id,
      body: String(req.body.body || "").trim(),
      replyToMessageId: req.body.replyToMessageId ? Number(req.body.replyToMessageId) : null,
      attachmentType,
      attachmentName: req.body.attachmentName || null,
      attachmentUrl: req.body.attachmentDataUrl || null,
      attachmentMime: attachmentMime || null,
      attachmentSize: req.body.attachmentSize ? Number(req.body.attachmentSize) : null,
      compressionApplied: Boolean(req.body.compressionApplied)
    });

    const enriched = {
      ...message,
      reactions: []
    };

    const chatId = Number(req.params.chatId);
    io.to(`chat:${chatId}`).emit("message:new", enriched);
    await emitChatSnapshot(chatId, req.user.id);
    res.status(201).json(enriched);
  } catch (error) {
    res.status(400).json({ message: error.message || "Unable to send message." });
  }
});

app.post("/api/messages/:messageId/reactions", requireAuth, async (req, res) => {
  await addReaction(
    Number(req.params.messageId),
    req.user.id,
    String(req.body.reaction || "").trim().slice(0, 24)
  );
  res.json({ ok: true });
});

app.post("/api/search", requireAuth, async (req, res) => {
  const term = String(req.body.q || "").trim();
  if (!term) {
    res.json({ chats: [], messages: [] });
    return;
  }

  const results = await searchWorkspace(req.user.id, term);
  res.json(results);
});

function inferAttachmentType(mimeType = "") {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "voice";
  }
  return "document";
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || "";
    const user = await getSessionUser(token);
    if (!user) {
      next(new Error("Unauthorized"));
      return;
    }

    socket.data.user = user;
    socket.data.token = token;
    next();
  } catch (error) {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", async (socket) => {
  const user = socket.data.user;
  socketUsers.set(socket.id, user.id);

  const count = onlineUsers.get(user.id) || 0;
  onlineUsers.set(user.id, count + 1);
  socket.join(`user:${user.id}`);
  emitPresence(user.id);

  const chats = await listUserChats(user.id);
  for (const chat of chats) {
    socket.join(`chat:${chat.id}`);
  }

  socket.emit("bootstrap", {
    user,
    chats,
    onlineCount: getOnlineCount()
  });

  socket.on("chat:join", async ({ chatId }) => {
    socket.join(`chat:${Number(chatId)}`);
  });

  socket.on("presence:sync", () => {
    socket.emit("presence:summary", { onlineCount: getOnlineCount() });
  });

  socket.on("typing:update", ({ chatId, state }) => {
    const key = `${chatId}:${user.id}`;
    if (state === "typing" || state === "recording") {
      chatTyping.set(key, { chatId, userId: user.id, state, name: user.name });
    } else {
      chatTyping.delete(key);
    }

    const indicators = [...chatTyping.values()].filter(
      (entry) => Number(entry.chatId) === Number(chatId) && entry.userId !== user.id
    );
    io.to(`chat:${chatId}`).emit("typing:update", {
      chatId: Number(chatId),
      indicators
    });
  });

  socket.on("message:status", async ({ chatId, messageId, status }) => {
    if (!["sent", "delivered", "read"].includes(status)) {
      return;
    }

    await updateMessageStatus(Number(messageId), user.id, status);

    if (status === "read") {
      await updateChatReadPointer(Number(chatId), user.id, Number(messageId));
    }

    io.to(`chat:${chatId}`).emit("message:status", {
      chatId: Number(chatId),
      messageId: Number(messageId),
      userId: user.id,
      status
    });
  });

  socket.on("message:react", async ({ chatId, messageId, reaction }) => {
    await addReaction(Number(messageId), user.id, String(reaction || "").slice(0, 24));
    const reactions = await listReactionsByMessageIds([Number(messageId)]);
    io.to(`chat:${chatId}`).emit("message:reactions", {
      chatId: Number(chatId),
      messageId: Number(messageId),
      reactions
    });
  });

  socket.on("disconnect", async () => {
    socketUsers.delete(socket.id);
    const nextCount = (onlineUsers.get(user.id) || 1) - 1;
    if (nextCount <= 0) {
      onlineUsers.delete(user.id);
      await touchLastSeen(user.id);
      emitPresence(user.id);
    } else {
      onlineUsers.set(user.id, nextCount);
      emitPresence(user.id);
    }

    for (const [key, entry] of chatTyping.entries()) {
      if (entry.userId === user.id) {
        chatTyping.delete(key);
        io.to(`chat:${entry.chatId}`).emit("typing:update", {
          chatId: Number(entry.chatId),
          indicators: [...chatTyping.values()].filter(
            (candidate) =>
              Number(candidate.chatId) === Number(entry.chatId) &&
              candidate.userId !== user.id
          )
        });
      }
    }
  });
});

async function start() {
  try {
    await initializeDatabase();
    server.listen(port, () => {
      console.log(`Server listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

start();
