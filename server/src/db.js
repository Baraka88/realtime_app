import crypto from "crypto";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const requiredEnv = ["DB_HOST", "DB_USER", "DB_NAME"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const connectionConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || ""
};

export const pool = mysql.createPool({
  ...connectionConfig,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  namedPlaceholders: true
});

function normalizeUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    phone: row.phone,
    name: row.name,
    avatarUrl: row.avatarUrl,
    about: row.about,
    customStatus: row.customStatus,
    twoFactorEnabled: Boolean(row.twoFactorEnabled),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    chatId: row.chatId,
    senderId: row.senderId,
    senderName: row.senderName,
    senderUsername: row.senderUsername,
    senderAvatarUrl: row.senderAvatarUrl,
    body: row.body,
    replyToMessageId: row.replyToMessageId,
    attachmentType: row.attachmentType,
    attachmentName: row.attachmentName,
    attachmentUrl: row.attachmentUrl,
    attachmentMime: row.attachmentMime,
    attachmentSize: row.attachmentSize,
    compressionApplied: Boolean(row.compressionApplied),
    status: row.status || "sent",
    createdAt: row.createdAt
  };
}

function dedupeIds(ids) {
  return [...new Set(ids.map((value) => Number(value)).filter(Boolean))];
}

async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function initializeDatabase() {
  const bootstrapConnection = await mysql.createConnection(connectionConfig);

  await bootstrapConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``
  );
  await bootstrapConnection.end();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      email VARCHAR(190) UNIQUE,
      phone VARCHAR(30) UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(120) NOT NULL,
      avatar_url TEXT,
      about VARCHAR(255) DEFAULT '',
      custom_status VARCHAR(255) DEFAULT '',
      is_2fa_enabled TINYINT(1) DEFAULT 0,
      last_seen_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('direct', 'group', 'broadcast') NOT NULL DEFAULT 'direct',
      name VARCHAR(120) DEFAULT NULL,
      description VARCHAR(255) DEFAULT '',
      avatar_url TEXT,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INT NOT NULL,
      user_id INT NOT NULL,
      role ENUM('admin', 'member') NOT NULL DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_read_message_id INT DEFAULT NULL,
      UNIQUE KEY unique_chat_member (chat_id, user_id),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      user_id INT NOT NULL,
      contact_user_id INT NOT NULL,
      alias_name VARCHAR(120) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_contact (user_id, contact_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_user_id INT NOT NULL,
      blocked_user_id INT NOT NULL,
      reason VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_block (blocker_user_id, blocked_user_id),
      FOREIGN KEY (blocker_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      reporter_user_id INT NOT NULL,
      reported_user_id INT NOT NULL,
      chat_id INT DEFAULT NULL,
      reason VARCHAR(255) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chat_id INT NOT NULL,
      sender_id INT NOT NULL,
      body TEXT,
      reply_to_message_id INT DEFAULT NULL,
      attachment_type ENUM('image', 'video', 'voice', 'document') DEFAULT NULL,
      attachment_name VARCHAR(255) DEFAULT NULL,
      attachment_url TEXT,
      attachment_mime VARCHAR(160) DEFAULT NULL,
      attachment_size INT DEFAULT NULL,
      compression_applied TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_receipts (
      message_id INT NOT NULL,
      user_id INT NOT NULL,
      status ENUM('sent', 'delivered', 'read') NOT NULL DEFAULT 'sent',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_receipt (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INT NOT NULL,
      user_id INT NOT NULL,
      reaction VARCHAR(24) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_reaction (message_id, user_id, reaction),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(password, hashedPassword) {
  const [salt, storedHash] = String(hashedPassword || "").split(":");
  if (!salt || !storedHash) {
    return false;
  }

  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(derivedKey, "hex")
  );
}

export async function createUser({
  username,
  email,
  phone,
  password,
  name,
  avatarUrl = "",
  about = "",
  customStatus = ""
}) {
  const passwordHash = hashPassword(password);

  const [result] = await pool.query(
    `
      INSERT INTO users (
        username, email, phone, password_hash, name, avatar_url, about, custom_status
      )
      VALUES (:username, :email, :phone, :passwordHash, :name, :avatarUrl, :about, :customStatus)
    `,
    {
      username,
      email: email || null,
      phone: phone || null,
      passwordHash,
      name,
      avatarUrl: avatarUrl || null,
      about,
      customStatus
    }
  );

  return getUserById(result.insertId);
}

export async function getUserById(userId) {
  const rows = await query(
    `
      SELECT
        id,
        username,
        email,
        phone,
        name,
        avatar_url AS avatarUrl,
        about,
        custom_status AS customStatus,
        is_2fa_enabled AS twoFactorEnabled,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt
      FROM users
      WHERE id = ?
    `,
    [userId]
  );

  return normalizeUser(rows[0]);
}

export async function getUserWithPasswordByIdentifier(identifier) {
  const rows = await query(
    `
      SELECT
        id,
        username,
        email,
        phone,
        name,
        avatar_url AS avatarUrl,
        about,
        custom_status AS customStatus,
        is_2fa_enabled AS twoFactorEnabled,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt,
        password_hash AS passwordHash
      FROM users
      WHERE username = ? OR email = ? OR phone = ?
      LIMIT 1
    `,
    [identifier, identifier, identifier]
  );

  return rows[0] || null;
}

export async function createSession(userId) {
  const token = crypto.randomBytes(48).toString("hex");
  await pool.query(
    `
      INSERT INTO sessions (token, user_id, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))
    `,
    [token, userId]
  );
  return token;
}

export async function getSessionUser(token) {
  const rows = await query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.phone,
        u.name,
        u.avatar_url AS avatarUrl,
        u.about,
        u.custom_status AS customStatus,
        u.is_2fa_enabled AS twoFactorEnabled,
        u.last_seen_at AS lastSeenAt,
        u.created_at AS createdAt
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
      LIMIT 1
    `,
    [token]
  );

  return normalizeUser(rows[0]);
}

export async function deleteSession(token) {
  await pool.query("DELETE FROM sessions WHERE token = ?", [token]);
}

export async function updateUserProfile(userId, payload) {
  await pool.query(
    `
      UPDATE users
      SET
        name = COALESCE(:name, name),
        avatar_url = COALESCE(:avatarUrl, avatar_url),
        about = COALESCE(:about, about),
        custom_status = COALESCE(:customStatus, custom_status),
        is_2fa_enabled = COALESCE(:twoFactorEnabled, is_2fa_enabled)
      WHERE id = :userId
    `,
    {
      userId,
      name: payload.name ?? null,
      avatarUrl: payload.avatarUrl ?? null,
      about: payload.about ?? null,
      customStatus: payload.customStatus ?? null,
      twoFactorEnabled:
        payload.twoFactorEnabled === undefined
          ? null
          : payload.twoFactorEnabled
          ? 1
          : 0
    }
  );

  return getUserById(userId);
}

export async function touchLastSeen(userId) {
  await pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = ?", [userId]);
}

export async function addContact(userId, contactUserId, aliasName = "") {
  await pool.query(
    `
      INSERT INTO contacts (user_id, contact_user_id, alias_name)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE alias_name = VALUES(alias_name)
    `,
    [userId, contactUserId, aliasName]
  );
}

export async function blockUser(blockerUserId, blockedUserId, reason = "") {
  await pool.query(
    `
      INSERT INTO blocks (blocker_user_id, blocked_user_id, reason)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE reason = VALUES(reason)
    `,
    [blockerUserId, blockedUserId, reason]
  );
}

export async function reportUser({
  reporterUserId,
  reportedUserId,
  chatId = null,
  reason,
  details = ""
}) {
  await pool.query(
    `
      INSERT INTO reports (reporter_user_id, reported_user_id, chat_id, reason, details)
      VALUES (?, ?, ?, ?, ?)
    `,
    [reporterUserId, reportedUserId, chatId, reason, details]
  );
}

export async function listContacts(userId) {
  return query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.phone,
        u.name,
        u.avatar_url AS avatarUrl,
        u.about,
        u.custom_status AS customStatus,
        u.is_2fa_enabled AS twoFactorEnabled,
        u.last_seen_at AS lastSeenAt,
        u.created_at AS createdAt,
        c.alias_name AS aliasName
      FROM contacts c
      JOIN users u ON u.id = c.contact_user_id
      WHERE c.user_id = ?
      ORDER BY u.name ASC, u.username ASC
    `,
    [userId]
  );
}

export async function searchUsers(userId, term) {
  const likeTerm = `%${term}%`;
  return query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.phone,
        u.name,
        u.avatar_url AS avatarUrl,
        u.about,
        u.custom_status AS customStatus,
        u.is_2fa_enabled AS twoFactorEnabled,
        u.last_seen_at AS lastSeenAt,
        u.created_at AS createdAt,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS isContact,
        CASE WHEN b.blocker_user_id IS NULL THEN 0 ELSE 1 END AS isBlocked
      FROM users u
      LEFT JOIN contacts c
        ON c.contact_user_id = u.id AND c.user_id = ?
      LEFT JOIN blocks b
        ON b.blocked_user_id = u.id AND b.blocker_user_id = ?
      WHERE u.id <> ?
        AND (
          u.username LIKE ?
          OR u.name LIKE ?
          OR COALESCE(u.email, '') LIKE ?
          OR COALESCE(u.phone, '') LIKE ?
        )
      ORDER BY isContact DESC, u.name ASC, u.username ASC
      LIMIT 20
    `,
    [userId, userId, userId, likeTerm, likeTerm, likeTerm, likeTerm]
  );
}

export async function createChat({
  type,
  name,
  description,
  avatarUrl,
  createdBy,
  memberIds
}) {
  const participantIds = dedupeIds([createdBy, ...memberIds]);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [chatResult] = await connection.query(
      `
        INSERT INTO chats (type, name, description, avatar_url, created_by)
        VALUES (?, ?, ?, ?, ?)
      `,
      [type, name || null, description || "", avatarUrl || null, createdBy]
    );

    for (const memberId of participantIds) {
      await connection.query(
        `
          INSERT INTO chat_members (chat_id, user_id, role)
          VALUES (?, ?, ?)
        `,
        [chatResult.insertId, memberId, memberId === createdBy ? "admin" : "member"]
      );
    }

    await connection.commit();
    return getChatById(chatResult.insertId, createdBy);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function findOrCreateDirectChat(userId, otherUserId) {
  const rows = await query(
    `
      SELECT c.id
      FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
      WHERE c.type = 'direct'
      LIMIT 1
    `,
    [userId, otherUserId]
  );

  if (rows[0]) {
    return getChatById(rows[0].id, userId);
  }

  return createChat({
    type: "direct",
    name: null,
    description: "",
    avatarUrl: "",
    createdBy: userId,
    memberIds: [otherUserId]
  });
}

export async function getChatById(chatId, viewerUserId) {
  const chatRows = await query(
    `
      SELECT
        c.id,
        c.type,
        c.name,
        c.description,
        c.avatar_url AS avatarUrl,
        c.created_by AS createdBy,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
      WHERE c.id = ?
      LIMIT 1
    `,
    [viewerUserId, chatId]
  );

  const chat = chatRows[0];
  if (!chat) {
    return null;
  }

  const members = await query(
    `
      SELECT
        cm.chat_id AS chatId,
        cm.user_id AS userId,
        cm.role,
        cm.last_read_message_id AS lastReadMessageId,
        u.username,
        u.name,
        u.avatar_url AS avatarUrl,
        u.about,
        u.custom_status AS customStatus,
        u.last_seen_at AS lastSeenAt
      FROM chat_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = ?
      ORDER BY cm.joined_at ASC
    `,
    [chatId]
  );

  const latestMessageRows = await query(
    `
      SELECT
        m.id,
        m.chat_id AS chatId,
        m.sender_id AS senderId,
        u.name AS senderName,
        u.username AS senderUsername,
        u.avatar_url AS senderAvatarUrl,
        m.body,
        m.reply_to_message_id AS replyToMessageId,
        m.attachment_type AS attachmentType,
        m.attachment_name AS attachmentName,
        m.attachment_url AS attachmentUrl,
        m.attachment_mime AS attachmentMime,
        m.attachment_size AS attachmentSize,
        m.compression_applied AS compressionApplied,
        m.created_at AS createdAt
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    `,
    [chatId]
  );

  return {
    ...chat,
    members,
    latestMessage: latestMessageRows[0] ? mapMessage(latestMessageRows[0]) : null
  };
}

export async function listUserChats(userId) {
  const rows = await query(
    `
      SELECT
        c.id,
        c.type,
        c.name,
        c.description,
        c.avatar_url AS avatarUrl,
        c.created_by AS createdBy,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        lm.id AS latestMessageId,
        lm.body AS latestMessageBody,
        lm.created_at AS latestMessageCreatedAt,
        sender.name AS latestSenderName,
        sender.username AS latestSenderUsername
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id
      LEFT JOIN messages lm ON lm.id = (
          SELECT id FROM messages
          WHERE chat_id = c.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
      LEFT JOIN users sender ON sender.id = lm.sender_id
      WHERE cm.user_id = ?
      ORDER BY COALESCE(lm.created_at, c.updated_at) DESC, c.updated_at DESC
    `,
    [userId]
  );

  const chatIds = rows.map((row) => row.id);
  const members = chatIds.length
    ? await query(
        `
          SELECT
            cm.chat_id AS chatId,
            cm.user_id AS userId,
            cm.role,
            cm.last_read_message_id AS lastReadMessageId,
            u.username,
            u.name,
            u.avatar_url AS avatarUrl,
            u.custom_status AS customStatus,
            u.last_seen_at AS lastSeenAt
          FROM chat_members cm
          JOIN users u ON u.id = cm.user_id
          WHERE cm.chat_id IN (${chatIds.map(() => "?").join(",")})
          ORDER BY cm.joined_at ASC
        `,
        chatIds
      )
    : [];

  return rows.map((chat) => ({
    ...chat,
    members: members.filter((member) => member.chatId === chat.id),
    latestMessage: chat.latestMessageId
      ? {
          id: chat.latestMessageId,
          body: chat.latestMessageBody,
          createdAt: chat.latestMessageCreatedAt,
          senderName: chat.latestSenderName,
          senderUsername: chat.latestSenderUsername
        }
      : null
  }));
}

export async function getChatMessages(chatId, userId, limit = 100) {
  const membership = await query(
    "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? LIMIT 1",
    [chatId, userId]
  );

  if (!membership[0]) {
    return [];
  }

  const rows = await query(
    `
      SELECT
        m.id,
        m.chat_id AS chatId,
        m.sender_id AS senderId,
        u.name AS senderName,
        u.username AS senderUsername,
        u.avatar_url AS senderAvatarUrl,
        m.body,
        m.reply_to_message_id AS replyToMessageId,
        m.attachment_type AS attachmentType,
        m.attachment_name AS attachmentName,
        m.attachment_url AS attachmentUrl,
        m.attachment_mime AS attachmentMime,
        m.attachment_size AS attachmentSize,
        m.compression_applied AS compressionApplied,
        mr.status,
        m.created_at AS createdAt
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN message_receipts mr
        ON mr.message_id = m.id AND mr.user_id = ?
      WHERE m.chat_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    `,
    [userId, chatId, limit]
  );

  return rows.reverse().map(mapMessage);
}

export async function createMessage({
  chatId,
  senderId,
  body,
  replyToMessageId = null,
  attachmentType = null,
  attachmentName = null,
  attachmentUrl = null,
  attachmentMime = null,
  attachmentSize = null,
  compressionApplied = false
}) {
  const membershipRows = await query(
    "SELECT user_id FROM chat_members WHERE chat_id = ?",
    [chatId]
  );

  if (!membershipRows.some((row) => row.user_id === senderId)) {
    throw new Error("You are not a member of this chat.");
  }

  const [blockedRows] = await pool.query(
    `
      SELECT 1
      FROM blocks b
      JOIN chat_members cm1 ON cm1.user_id = b.blocker_user_id AND cm1.chat_id = ?
      WHERE b.blocked_user_id = ?
      LIMIT 1
    `,
    [chatId, senderId]
  );

  if (blockedRows[0]) {
    throw new Error("A participant has blocked this sender.");
  }

  const [result] = await pool.query(
    `
      INSERT INTO messages (
        chat_id,
        sender_id,
        body,
        reply_to_message_id,
        attachment_type,
        attachment_name,
        attachment_url,
        attachment_mime,
        attachment_size,
        compression_applied
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      chatId,
      senderId,
      body || null,
      replyToMessageId,
      attachmentType,
      attachmentName,
      attachmentUrl,
      attachmentMime,
      attachmentSize,
      compressionApplied ? 1 : 0
    ]
  );

  for (const member of membershipRows) {
    const status = member.user_id === senderId ? "read" : "sent";
    await pool.query(
      `
        INSERT INTO message_receipts (message_id, user_id, status)
        VALUES (?, ?, ?)
      `,
      [result.insertId, member.user_id, status]
    );
  }

  const rows = await query(
    `
      SELECT
        m.id,
        m.chat_id AS chatId,
        m.sender_id AS senderId,
        u.name AS senderName,
        u.username AS senderUsername,
        u.avatar_url AS senderAvatarUrl,
        m.body,
        m.reply_to_message_id AS replyToMessageId,
        m.attachment_type AS attachmentType,
        m.attachment_name AS attachmentName,
        m.attachment_url AS attachmentUrl,
        m.attachment_mime AS attachmentMime,
        m.attachment_size AS attachmentSize,
        m.compression_applied AS compressionApplied,
        mr.status,
        m.created_at AS createdAt
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN message_receipts mr
        ON mr.message_id = m.id AND mr.user_id = ?
      WHERE m.id = ?
      LIMIT 1
    `,
    [senderId, result.insertId]
  );

  return mapMessage(rows[0]);
}

function statusRank(status) {
  return {
    sent: 1,
    delivered: 2,
    read: 3
  }[status] || 1;
}

export async function updateMessageStatus(messageId, userId, status) {
  const existingRows = await query(
    "SELECT status FROM message_receipts WHERE message_id = ? AND user_id = ? LIMIT 1",
    [messageId, userId]
  );

  if (existingRows[0] && statusRank(existingRows[0].status) > statusRank(status)) {
    return;
  }

  await pool.query(
    `
      INSERT INTO message_receipts (message_id, user_id, status)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE status = VALUES(status)
    `,
    [messageId, userId, status]
  );
}

export async function updateChatReadPointer(chatId, userId, messageId) {
  await pool.query(
    `
      UPDATE chat_members
      SET last_read_message_id = ?
      WHERE chat_id = ? AND user_id = ?
    `,
    [messageId, chatId, userId]
  );
}

export async function addReaction(messageId, userId, reaction) {
  await pool.query(
    `
      INSERT INTO message_reactions (message_id, user_id, reaction)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE reaction = VALUES(reaction)
    `,
    [messageId, userId, reaction]
  );
}

export async function removeReaction(messageId, userId, reaction) {
  await pool.query(
    `
      DELETE FROM message_reactions
      WHERE message_id = ? AND user_id = ? AND reaction = ?
    `,
    [messageId, userId, reaction]
  );
}

export async function listReactionsByMessageIds(messageIds) {
  if (!messageIds.length) {
    return [];
  }

  return query(
    `
      SELECT
        mr.message_id AS messageId,
        mr.user_id AS userId,
        u.name,
        u.username,
        mr.reaction,
        mr.created_at AS createdAt
      FROM message_reactions mr
      JOIN users u ON u.id = mr.user_id
      WHERE mr.message_id IN (${messageIds.map(() => "?").join(",")})
      ORDER BY mr.created_at ASC
    `,
    messageIds
  );
}

export async function searchWorkspace(userId, term) {
  const likeTerm = `%${term}%`;
  const chats = await query(
    `
      SELECT DISTINCT
        c.id,
        c.type,
        c.name,
        c.description,
        c.avatar_url AS avatarUrl
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
      LEFT JOIN chat_members others ON others.chat_id = c.id
      LEFT JOIN users u ON u.id = others.user_id
      WHERE c.name LIKE ?
        OR c.description LIKE ?
        OR u.name LIKE ?
        OR u.username LIKE ?
      ORDER BY c.updated_at DESC
      LIMIT 20
    `,
    [userId, likeTerm, likeTerm, likeTerm, likeTerm]
  );

  const messages = await query(
    `
      SELECT
        m.id,
        m.chat_id AS chatId,
        m.body,
        m.attachment_name AS attachmentName,
        m.created_at AS createdAt,
        u.name AS senderName
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE COALESCE(m.body, '') LIKE ?
        OR COALESCE(m.attachment_name, '') LIKE ?
      ORDER BY m.created_at DESC
      LIMIT 30
    `,
    [userId, likeTerm, likeTerm]
  );

  return { chats, messages };
}
