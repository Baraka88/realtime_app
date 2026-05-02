import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";

const emptyAuthForm = {
  name: "",
  username: "",
  email: "",
  phone: "",
  password: ""
};

const reactionOptions = ["👍", "❤️", "🔥", "😂", "👏"];

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function apiRequest(path, options = {}, token) {
  const headers = {
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
    ...(token ? authHeaders(token) : {})
  };

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "Request failed.");
  }

  return data;
}

function getInitials(name) {
  const parts = String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "?";
}

function formatChatTitle(chat, currentUserId) {
  if (chat.type === "group" || chat.type === "broadcast") {
    return chat.name || "Untitled group";
  }

  const counterpart = (chat.members || []).find((member) => member.userId !== currentUserId);
  return counterpart?.name || counterpart?.username || "Direct chat";
}

function formatPresence(member, presenceMap) {
  const presence = presenceMap[member.userId];
  if (presence?.isOnline) {
    return "Active now";
  }
  if (member.customStatus) {
    return member.customStatus;
  }
  if (member.lastSeenAt) {
    return `Seen ${new Date(member.lastSeenAt).toLocaleString()}`;
  }
  return "Offline";
}

function aggregateReactions(reactions = []) {
  const grouped = new Map();
  for (const reaction of reactions) {
    grouped.set(reaction.reaction, (grouped.get(reaction.reaction) || 0) + 1);
  }
  return [...grouped.entries()];
}

function formatMessageTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatChatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? formatMessageTime(value)
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function compressSelectedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    return { file, compressed: false, previewUrl: file ? URL.createObjectURL(file) : "" };
  }

  const imageUrl = URL.createObjectURL(file);
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = reject;
    element.src = imageUrl;
  });

  const maxWidth = 1600;
  const scale = Math.min(1, maxWidth / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));

  URL.revokeObjectURL(imageUrl);

  if (!blob || blob.size >= file.size) {
    return { file, compressed: false, previewUrl: URL.createObjectURL(file) };
  }

  const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
    type: "image/jpeg"
  });

  return {
    file: compressedFile,
    compressed: true,
    previewUrl: URL.createObjectURL(compressedFile)
  };
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [mode, setMode] = useState("login");
  const [authForm, setAuthForm] = useState(emptyAuthForm);
  const [profileForm, setProfileForm] = useState({
    name: "",
    avatarUrl: "",
    about: "",
    customStatus: "",
    twoFactorEnabled: false
  });
  const [token, setToken] = useState(() => sessionStorage.getItem("pulse_token") || "");
  const [currentUser, setCurrentUser] = useState(null);
  const [chats, setChats] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messagesByChat, setMessagesByChat] = useState({});
  const [presenceMap, setPresenceMap] = useState({});
  const [typingMap, setTypingMap] = useState({});
  const [onlineCount, setOnlineCount] = useState(0);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [workspaceResults, setWorkspaceResults] = useState({ chats: [], messages: [] });
  const [peopleSearch, setPeopleSearch] = useState("");
  const [peopleResults, setPeopleResults] = useState([]);
  const [groupDraft, setGroupDraft] = useState({ name: "", description: "", memberIds: [] });
  const [composer, setComposer] = useState({
    body: "",
    selectedFile: null,
    previewUrl: "",
    compressionApplied: false,
    replyToMessageId: null,
    typingState: "idle"
  });
  const [authError, setAuthError] = useState("");
  const [appError, setAppError] = useState("");
  const [alerts, setAlerts] = useState([]);
  const [rightPanelTab, setRightPanelTab] = useState("people");
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const typingTimerRef = useRef(null);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) || null,
    [activeChatId, chats]
  );

  const activeMessages = messagesByChat[activeChatId] || [];

  const activeDirectMember = useMemo(() => {
    if (!activeChat || !currentUser || activeChat.type !== "direct") {
      return null;
    }
    return (activeChat.members || []).find((member) => member.userId !== currentUser.id) || null;
  }, [activeChat, currentUser]);

  const featuredPeople = useMemo(() => {
    const mappedContacts = contacts.map((contact) => ({
      id: contact.id,
      name: contact.aliasName || contact.name,
      username: contact.username,
      customStatus: contact.customStatus,
      lastSeenAt: contact.lastSeenAt
    }));

    if (mappedContacts.length) {
      return mappedContacts.slice(0, 8);
    }

    return peopleResults.slice(0, 8);
  }, [contacts, peopleResults]);

  useEffect(() => {
    if (!token) {
      return;
    }

    sessionStorage.setItem("pulse_token", token);
    bootstrapSession(token);

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [token]);

  useEffect(() => {
    if (!activeChatId || !token) {
      return;
    }

    loadChatMessages(activeChatId, token);
  }, [activeChatId, token]);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [activeMessages]);

  useEffect(() => {
    if (!workspaceSearch.trim() || !token) {
      setWorkspaceResults({ chats: [], messages: [] });
      return;
    }

    const timeoutId = setTimeout(async () => {
      try {
        const results = await apiRequest(
          "/api/search",
          {
            method: "POST",
            body: JSON.stringify({ q: workspaceSearch })
          },
          token
        );
        setWorkspaceResults(results);
      } catch (error) {
        setAppError(error.message);
      }
    }, 250);

    return () => clearTimeout(timeoutId);
  }, [workspaceSearch, token]);

  useEffect(() => {
    if (!peopleSearch.trim() || !token) {
      setPeopleResults([]);
      return;
    }

    const timeoutId = setTimeout(async () => {
      try {
        const results = await apiRequest(
          `/api/users/search?q=${encodeURIComponent(peopleSearch)}`,
          {},
          token
        );
        setPeopleResults(results);
      } catch (error) {
        setAppError(error.message);
      }
    }, 250);

    return () => clearTimeout(timeoutId);
  }, [peopleSearch, token]);

  async function bootstrapSession(sessionToken) {
    try {
      const data = await apiRequest("/api/me", {}, sessionToken);
      setCurrentUser(data.user);
      setProfileForm({
        name: data.user.name || "",
        avatarUrl: data.user.avatarUrl || "",
        about: data.user.about || "",
        customStatus: data.user.customStatus || "",
        twoFactorEnabled: Boolean(data.user.twoFactorEnabled)
      });
      setChats(data.chats || []);
      setContacts(data.contacts || []);
      setOnlineCount(data.stats?.onlineCount || 0);
      if (!activeChatId && data.chats?.[0]?.id) {
        setActiveChatId(data.chats[0].id);
      }
      connectSocket(sessionToken);
    } catch (error) {
      setAuthError(error.message);
      setToken("");
      sessionStorage.removeItem("pulse_token");
    }
  }

  function connectSocket(sessionToken) {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = io(apiBaseUrl, {
      auth: {
        token: sessionToken
      }
    });

    socket.on("bootstrap", (payload) => {
      setOnlineCount(payload.onlineCount || 0);
      setChats(payload.chats || []);
      setCurrentUser(payload.user || null);
      if (!activeChatId && payload.chats?.[0]?.id) {
        setActiveChatId(payload.chats[0].id);
      }
    });

    socket.on("presence:summary", (payload) => {
      setOnlineCount(payload.onlineCount || 0);
    });

    socket.on("presence:user", (payload) => {
      setPresenceMap((current) => ({
        ...current,
        [payload.userId]: payload
      }));
    });

    socket.on("chat:updated", (chat) => {
      setChats((current) => {
        const existing = current.find((item) => item.id === chat.id);
        if (!existing) {
          return [chat, ...current];
        }
        return current.map((item) => (item.id === chat.id ? { ...item, ...chat } : item));
      });
    });

    socket.on("message:new", (message) => {
      setMessagesByChat((current) => ({
        ...current,
        [message.chatId]: [...(current[message.chatId] || []), message]
      }));

      if (
        currentUser &&
        message.senderId !== currentUser.id &&
        message.body?.includes(`@${currentUser.username}`)
      ) {
        addAlert("You were mentioned");
      }

      if (activeChatId !== message.chatId && message.senderId !== currentUser?.id) {
        addAlert("New message");
      }

      if (socketRef.current && message.senderId !== currentUser?.id) {
        socketRef.current.emit("message:status", {
          chatId: message.chatId,
          messageId: message.id,
          status: "delivered"
        });
      }
    });

    socket.on("message:status", ({ chatId, messageId, status }) => {
      setMessagesByChat((current) => ({
        ...current,
        [chatId]: (current[chatId] || []).map((message) =>
          message.id === messageId ? { ...message, status } : message
        )
      }));
    });

    socket.on("message:reactions", ({ chatId, messageId, reactions }) => {
      setMessagesByChat((current) => ({
        ...current,
        [chatId]: (current[chatId] || []).map((message) =>
          message.id === messageId ? { ...message, reactions } : message
        )
      }));
    });

    socket.on("typing:update", ({ chatId, indicators }) => {
      setTypingMap((current) => ({
        ...current,
        [chatId]: indicators
      }));
    });

    socketRef.current = socket;
  }

  function addAlert(text) {
    const alert = { id: Date.now() + Math.random(), text };
    setAlerts((current) => [alert, ...current].slice(0, 5));
    setTimeout(() => {
      setAlerts((current) => current.filter((item) => item.id !== alert.id));
    }, 4000);
  }

  async function loadChatMessages(chatId, sessionToken = token) {
    try {
      const messages = await apiRequest(`/api/chats/${chatId}/messages`, {}, sessionToken);
      setMessagesByChat((current) => ({
        ...current,
        [chatId]: messages
      }));
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && socketRef.current) {
        socketRef.current.emit("message:status", {
          chatId,
          messageId: lastMessage.id,
          status: "read"
        });
      }
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthError("");

    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload =
        mode === "login"
          ? {
              identifier: authForm.email || authForm.phone || authForm.username,
              password: authForm.password
            }
          : authForm;

      const data = await apiRequest(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      setToken(data.token);
    } catch (error) {
      setAuthError(error.message);
    }
  }

  async function handleProfileSave(event) {
    event.preventDefault();
    try {
      const updated = await apiRequest(
        "/api/me",
        {
          method: "PATCH",
          body: JSON.stringify(profileForm)
        },
        token
      );
      setCurrentUser(updated);
      addAlert("Profile updated");
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleDirectChat(userId) {
    try {
      const chat = await apiRequest(
        "/api/chats/direct",
        {
          method: "POST",
          body: JSON.stringify({ userId })
        },
        token
      );
      setChats((current) => {
        const exists = current.some((item) => item.id === chat.id);
        return exists ? current : [chat, ...current];
      });
      setActiveChatId(chat.id);
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleAddContact(userId) {
    try {
      await apiRequest(
        "/api/contacts",
        {
          method: "POST",
          body: JSON.stringify({ contactUserId: userId })
        },
        token
      );
      const data = await apiRequest("/api/me", {}, token);
      setContacts(data.contacts || []);
      addAlert("Added to close friends");
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleBlockUser(userId) {
    try {
      await apiRequest(
        "/api/blocks",
        {
          method: "POST",
          body: JSON.stringify({ blockedUserId: userId, reason: "Blocked from UI" })
        },
        token
      );
      addAlert("User blocked");
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleReportUser(userId) {
    try {
      await apiRequest(
        "/api/reports",
        {
          method: "POST",
          body: JSON.stringify({
            reportedUserId: userId,
            chatId: activeChatId,
            reason: "Manual report",
            details: "Reported from workspace"
          })
        },
        token
      );
      addAlert("Report sent");
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleCreateGroup(event) {
    event.preventDefault();
    try {
      const chat = await apiRequest(
        "/api/chats/group",
        {
          method: "POST",
          body: JSON.stringify(groupDraft)
        },
        token
      );
      setChats((current) => [chat, ...current]);
      setActiveChatId(chat.id);
      setGroupDraft({ name: "", description: "", memberIds: [] });
      addAlert("Group created");
    } catch (error) {
      setAppError(error.message);
    }
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const prepared = await compressSelectedFile(file);
    setComposer((current) => {
      if (current.previewUrl) {
        URL.revokeObjectURL(current.previewUrl);
      }
      return {
        ...current,
        selectedFile: prepared.file,
        previewUrl: prepared.previewUrl,
        compressionApplied: prepared.compressed
      };
    });
  }

  function clearComposerMedia() {
    setComposer((current) => {
      if (current.previewUrl) {
        URL.revokeObjectURL(current.previewUrl);
      }
      return {
        ...current,
        selectedFile: null,
        previewUrl: "",
        compressionApplied: false
      };
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function emitTypingState(nextState) {
    if (!socketRef.current || !activeChatId) {
      return;
    }
    socketRef.current.emit("typing:update", {
      chatId: activeChatId,
      state: nextState
    });
  }

  function handleComposerTextChange(value) {
    setComposer((current) => ({
      ...current,
      body: value,
      typingState: value ? "typing" : "idle"
    }));

    emitTypingState(value ? "typing" : "idle");
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      emitTypingState("idle");
    }, 1200);
  }

  async function handleSendMessage(event) {
    event.preventDefault();
    if (!activeChatId) {
      return;
    }

    try {
      const payload = {
        body: composer.body,
        replyToMessageId: composer.replyToMessageId,
        compressionApplied: composer.compressionApplied
      };

      if (composer.selectedFile) {
        payload.attachmentType = inferClientAttachmentType(composer.selectedFile);
        payload.attachmentName = composer.selectedFile.name;
        payload.attachmentMime = composer.selectedFile.type;
        payload.attachmentSize = composer.selectedFile.size;
        payload.attachmentDataUrl = await fileToDataUrl(composer.selectedFile);
      }

      await apiRequest(
        `/api/chats/${activeChatId}/messages`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        },
        token
      );

      emitTypingState("idle");
      setComposer({
        body: "",
        selectedFile: null,
        previewUrl: "",
        compressionApplied: false,
        replyToMessageId: null,
        typingState: "idle"
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setAppError(error.message);
    }
  }

  function inferClientAttachmentType(file) {
    if (file.type.startsWith("image/")) {
      return "image";
    }
    if (file.type.startsWith("video/")) {
      return "video";
    }
    if (file.type.startsWith("audio/")) {
      return "voice";
    }
    return "document";
  }

  function toggleGroupMember(userId) {
    setGroupDraft((current) => ({
      ...current,
      memberIds: current.memberIds.includes(userId)
        ? current.memberIds.filter((id) => id !== userId)
        : [...current.memberIds, userId]
    }));
  }

  function logout() {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setToken("");
    setCurrentUser(null);
    setChats([]);
    setContacts([]);
    setMessagesByChat({});
    sessionStorage.removeItem("pulse_token");
  }

  function reactToMessage(messageId, reaction) {
    if (!socketRef.current || !activeChatId) {
      return;
    }

    socketRef.current.emit("message:react", {
      chatId: activeChatId,
      messageId,
      reaction
    });
  }

  if (!currentUser) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-logo">
            <div className="auth-logo-icon">P</div>
            <div>
              <h1>Pulse</h1>
              <p>Social messaging for your inner circle</p>
            </div>
          </div>

          <div className="auth-tabs">
            <button
              type="button"
              className={mode === "login" ? "active" : ""}
              onClick={() => setMode("login")}
            >
              Login
            </button>
            <button
              type="button"
              className={mode === "register" ? "active" : ""}
              onClick={() => setMode("register")}
            >
              Register
            </button>
          </div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            {mode === "register" ? (
              <>
                <div className="field">
                  <label>Name</label>
                  <input
                    value={authForm.name}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Display name"
                  />
                </div>
                <div className="field">
                  <label>Username</label>
                  <input
                    value={authForm.username}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, username: event.target.value }))
                    }
                    placeholder="@username"
                  />
                </div>
                <div className="dual">
                  <div className="field">
                    <label>Email</label>
                    <input
                      value={authForm.email}
                      onChange={(event) =>
                        setAuthForm((current) => ({ ...current, email: event.target.value }))
                      }
                      placeholder="you@example.com"
                    />
                  </div>
                  <div className="field">
                    <label>Phone</label>
                    <input
                      value={authForm.phone}
                      onChange={(event) =>
                        setAuthForm((current) => ({ ...current, phone: event.target.value }))
                      }
                      placeholder="+1..."
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="field">
                <label>Email, phone, or username</label>
                <input
                  value={authForm.email || authForm.phone || authForm.username}
                  onChange={(event) =>
                    setAuthForm((current) => ({
                      ...current,
                      email: event.target.value,
                      phone: "",
                      username: ""
                    }))
                  }
                  placeholder="Login identifier"
                />
              </div>
            )}

            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm((current) => ({ ...current, password: event.target.value }))
                }
                placeholder="Password"
              />
            </div>

            <p className="auth-error">{authError}</p>
            <button className="btn-primary" type="submit">
              {mode === "login" ? "Open inbox" : "Create account"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace">
      <nav className="nav-rail">
        <div className="nav-logo">P</div>
        <button className="nav-btn active" type="button" title="Inbox">
          ⌂
        </button>
        <button className="nav-btn" type="button" title="Explore">
          ◌
        </button>
        <button className="nav-btn" type="button" title="Notifications">
          ♡
        </button>
        <button className="nav-btn" type="button" title="Search">
          ⌕
        </button>
        <div className="nav-spacer" />
        <button className="nav-avatar" type="button" onClick={logout} title="Logout">
          {getInitials(currentUser.name)}
        </button>
      </nav>

      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>{currentUser.username}</h2>
          <button className="icon-btn" type="button" onClick={() => setRightPanelTab("profile")}>
            ✎
          </button>
        </div>

        <div className="sidebar-search">
          <div className="search-wrap">
            <span className="search-icon">⌕</span>
            <input
              value={workspaceSearch}
              onChange={(event) => setWorkspaceSearch(event.target.value)}
              placeholder="Search"
            />
          </div>
        </div>

        <div className="stories-strip">
          {featuredPeople.map((person) => (
            <button
              key={person.id}
              className="story-item"
              type="button"
              onClick={() => handleDirectChat(person.id)}
            >
              <div className="story-avatar">{getInitials(person.name)}</div>
              <span>{person.name.split(" ")[0]}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-header sidebar-subheader">
          <h2>Messages</h2>
          <span>{onlineCount} online</span>
        </div>

        <div className="chat-list">
          {(workspaceSearch.trim() ? workspaceResults.chats : chats).map((chat) => {
            const title = formatChatTitle(chat, currentUser.id);
            const counterpart = (chat.members || []).find(
              (member) => member.userId !== currentUser.id
            );
            const preview = chat.latestMessage?.body || chat.latestMessage?.senderName || "Say hi";
            const isOnline = counterpart ? presenceMap[counterpart.userId]?.isOnline : false;

            return (
              <button
                key={chat.id}
                type="button"
                className={`chat-item ${chat.id === activeChatId ? "active" : ""}`}
                onClick={() => setActiveChatId(chat.id)}
              >
                <div className="chat-avatar">
                  {getInitials(title)}
                  {isOnline ? <span className="online-dot" /> : null}
                </div>
                <div className="chat-info">
                  <div className="chat-name">{title}</div>
                  <div className="chat-preview">{preview}</div>
                </div>
                <div className="chat-meta">
                  <span className="chat-time">
                    {formatChatTime(chat.latestMessage?.createdAt || chat.updatedAt)}
                  </span>
                </div>
              </button>
            );
          })}

          {workspaceSearch.trim() && workspaceResults.messages.length ? (
            <>
              <div className="section-label">Message Results</div>
              {workspaceResults.messages.map((message) => (
                <button
                  key={`message-${message.id}`}
                  type="button"
                  className="search-result-item"
                  onClick={() => setActiveChatId(message.chatId)}
                >
                  <div className="chat-avatar">{getInitials(message.senderName)}</div>
                  <div>
                    <strong>{message.senderName}</strong>
                    <span>{message.body || message.attachmentName}</span>
                  </div>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </aside>

      <section className="chat-main">
        {activeChat ? (
          <>
            <header className="chat-topbar">
              <div className="chat-avatar">{getInitials(formatChatTitle(activeChat, currentUser.id))}</div>
              <div className="chat-topbar-info">
                <div className="chat-topbar-name">{formatChatTitle(activeChat, currentUser.id)}</div>
                <div className="chat-topbar-sub">
                  {activeChat.type === "direct" && activeDirectMember
                    ? formatPresence(activeDirectMember, presenceMap)
                    : `${activeChat.members?.length || 0} members`}
                </div>
              </div>
              <div className="topbar-actions">
                {activeDirectMember ? (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleBlockUser(activeDirectMember.userId)}
                      title="Block"
                    >
                      ⊘
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleReportUser(activeDirectMember.userId)}
                      title="Report"
                    >
                      !
                    </button>
                  </>
                ) : null}
              </div>
            </header>

            <div className="messages-area" ref={listRef}>
              {activeMessages.map((message, index) => {
                const isSelf = message.senderId === currentUser.id;
                const showSender = !isSelf && activeChat.type !== "direct";
                const previous = activeMessages[index - 1];
                const needsDateDivider =
                  !previous ||
                  new Date(previous.createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString();

                return (
                  <div key={message.id}>
                    {needsDateDivider ? (
                      <div className="date-divider">
                        {new Date(message.createdAt).toLocaleDateString([], {
                          weekday: "short",
                          month: "short",
                          day: "numeric"
                        })}
                      </div>
                    ) : null}

                    <div className={`msg-row ${isSelf ? "self" : "other"}`}>
                      {!isSelf ? (
                        <div className="msg-avatar">{getInitials(message.senderName)}</div>
                      ) : null}

                      <div className="msg-bubble-wrap">
                        {showSender ? <div className="msg-sender">{message.senderName}</div> : null}

                        <div className="msg-bubble">
                          <div className="msg-actions">
                            <button
                              type="button"
                              className="msg-action-btn"
                              onClick={() =>
                                setComposer((current) => ({
                                  ...current,
                                  replyToMessageId: message.id
                                }))
                              }
                            >
                              Reply
                            </button>
                            {reactionOptions.map((reaction) => (
                              <button
                                key={`${message.id}-${reaction}`}
                                type="button"
                                className="msg-action-btn"
                                onClick={() => reactToMessage(message.id, reaction)}
                              >
                                {reaction}
                              </button>
                            ))}
                          </div>

                          {message.replyToMessageId ? (
                            <div className="reply-preview">
                              Reply to message #{message.replyToMessageId}
                            </div>
                          ) : null}

                          {message.body ? <div>{message.body}</div> : null}

                          {message.attachmentUrl ? (
                            <div className="attachment-wrap">
                              {message.attachmentType === "image" ? (
                                <img src={message.attachmentUrl} alt={message.attachmentName} />
                              ) : message.attachmentType === "video" ? (
                                <video src={message.attachmentUrl} controls />
                              ) : message.attachmentType === "voice" ? (
                                <audio src={message.attachmentUrl} controls />
                              ) : (
                                <a
                                  className="attachment-link"
                                  href={message.attachmentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {message.attachmentName || "Open document"}
                                </a>
                              )}
                            </div>
                          ) : null}

                          {message.reactions?.length ? (
                            <div className="reactions-row">
                              {aggregateReactions(message.reactions).map(([reaction, count]) => (
                                <span key={`${message.id}-${reaction}`} className="reaction-chip">
                                  {reaction} {count}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="msg-footer">
                          <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
                          {isSelf ? (
                            <span
                              className={`msg-status ${
                                message.status === "read" ? "read" : ""
                              }`}
                            >
                              {message.status}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="typing-indicator">
              {(typingMap[activeChat.id] || []).length ? (
                <>
                  <div className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span>
                    {(typingMap[activeChat.id] || [])
                      .map((indicator) => `${indicator.name} is ${indicator.state}`)
                      .join(", ")}
                  </span>
                </>
              ) : null}
            </div>

            <div className="composer-wrap">
              {composer.replyToMessageId ? (
                <div className="reply-banner">
                  <span>Replying to message #{composer.replyToMessageId}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() =>
                      setComposer((current) => ({ ...current, replyToMessageId: null }))
                    }
                  >
                    ×
                  </button>
                </div>
              ) : null}

              {composer.previewUrl ? (
                <div className="attachment-preview">
                  {composer.selectedFile?.type.startsWith("image/") ? (
                    <img src={composer.previewUrl} alt="Preview" />
                  ) : (
                    <div className="chat-avatar">{getInitials(composer.selectedFile?.name)}</div>
                  )}
                  <span className="attachment-preview-name">
                    {composer.selectedFile?.name}
                    {composer.compressionApplied ? " · compressed" : ""}
                  </span>
                  <button type="button" className="icon-btn" onClick={clearComposerMedia}>
                    ×
                  </button>
                </div>
              ) : null}

              <form className="composer-row" onSubmit={handleSendMessage}>
                <div className="composer-input-wrap">
                  <textarea
                    rows="1"
                    value={composer.body}
                    onChange={(event) => handleComposerTextChange(event.target.value)}
                    placeholder="Message..."
                  />
                  <input
                    ref={fileInputRef}
                    hidden
                    type="file"
                    onChange={handleFileChange}
                    id="composer-file"
                  />
                  <label htmlFor="composer-file" className="attach-btn">
                    +
                  </label>
                </div>

                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    const next = composer.typingState === "recording" ? "idle" : "recording";
                    setComposer((current) => ({ ...current, typingState: next }));
                    emitTypingState(next);
                  }}
                  title="Voice note"
                >
                  {composer.typingState === "recording" ? "■" : "◉"}
                </button>

                <button
                  className="send-btn"
                  type="submit"
                  disabled={!composer.body.trim() && !composer.selectedFile}
                >
                  ↑
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="empty-chat">
            <div className="empty-chat-icon">✦</div>
            <p>Select a conversation to start chatting</p>
          </div>
        )}
      </section>

      <aside className="right-panel">
        <div className="right-panel-tabs">
          <button
            type="button"
            className={`rp-tab ${rightPanelTab === "people" ? "active" : ""}`}
            onClick={() => setRightPanelTab("people")}
          >
            People
          </button>
          <button
            type="button"
            className={`rp-tab ${rightPanelTab === "groups" ? "active" : ""}`}
            onClick={() => setRightPanelTab("groups")}
          >
            Groups
          </button>
          <button
            type="button"
            className={`rp-tab ${rightPanelTab === "profile" ? "active" : ""}`}
            onClick={() => setRightPanelTab("profile")}
          >
            Profile
          </button>
          <button
            type="button"
            className={`rp-tab ${rightPanelTab === "alerts" ? "active" : ""}`}
            onClick={() => setRightPanelTab("alerts")}
          >
            Alerts
          </button>
        </div>

        <div className="right-panel-body">
          {rightPanelTab === "people" ? (
            <>
              <div className="search-wrap">
                <span className="search-icon">⌕</span>
                <input
                  value={peopleSearch}
                  onChange={(event) => setPeopleSearch(event.target.value)}
                  placeholder="Find people"
                />
              </div>

              {(peopleResults.length ? peopleResults : featuredPeople).map((person) => (
                <article className="person-card" key={person.id}>
                  <div className="person-avatar">{getInitials(person.name)}</div>
                  <div className="person-info">
                    <div className="person-name">{person.name}</div>
                    <div className="person-sub">
                      @{person.username}
                      {person.customStatus ? ` · ${person.customStatus}` : ""}
                    </div>
                  </div>
                  <div className="person-btns">
                    <button
                      type="button"
                      className="pill-btn"
                      onClick={() => handleDirectChat(person.id)}
                    >
                      DM
                    </button>
                    <button
                      type="button"
                      className="pill-btn"
                      onClick={() => handleAddContact(person.id)}
                    >
                      Add
                    </button>
                  </div>
                </article>
              ))}
            </>
          ) : null}

          {rightPanelTab === "groups" ? (
            <form className="group-form" onSubmit={handleCreateGroup}>
              <div className="section-label">Create group</div>
              <input
                value={groupDraft.name}
                onChange={(event) =>
                  setGroupDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Group name"
              />
              <input
                value={groupDraft.description}
                onChange={(event) =>
                  setGroupDraft((current) => ({
                    ...current,
                    description: event.target.value
                  }))
                }
                placeholder="Description"
              />
              <div className="member-count">{groupDraft.memberIds.length} people selected</div>
              {contacts.map((contact) => (
                <label className="person-card" key={contact.id}>
                  <div className="person-avatar">{getInitials(contact.name)}</div>
                  <div className="person-info">
                    <div className="person-name">{contact.aliasName || contact.name}</div>
                    <div className="person-sub">@{contact.username}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={groupDraft.memberIds.includes(contact.id)}
                    onChange={() => toggleGroupMember(contact.id)}
                  />
                </label>
              ))}
              <button className="btn-primary" type="submit">
                Create group
              </button>
            </form>
          ) : null}

          {rightPanelTab === "profile" ? (
            <form className="profile-form" onSubmit={handleProfileSave}>
              <div className="section-label">Your profile</div>
              <input
                value={profileForm.name}
                onChange={(event) =>
                  setProfileForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Display name"
              />
              <input
                value={profileForm.avatarUrl}
                onChange={(event) =>
                  setProfileForm((current) => ({ ...current, avatarUrl: event.target.value }))
                }
                placeholder="Avatar URL"
              />
              <input
                value={profileForm.customStatus}
                onChange={(event) =>
                  setProfileForm((current) => ({
                    ...current,
                    customStatus: event.target.value
                  }))
                }
                placeholder="Status"
              />
              <textarea
                rows="3"
                value={profileForm.about}
                onChange={(event) =>
                  setProfileForm((current) => ({ ...current, about: event.target.value }))
                }
                placeholder="About"
              />
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={profileForm.twoFactorEnabled}
                  onChange={(event) =>
                    setProfileForm((current) => ({
                      ...current,
                      twoFactorEnabled: event.target.checked
                    }))
                  }
                />
                <span>Two-factor enabled</span>
              </label>
              <button className="btn-primary" type="submit">
                Save changes
              </button>
            </form>
          ) : null}

          {rightPanelTab === "alerts" ? (
            <>
              <div className="section-label">Notifications</div>
              {alerts.length ? (
                alerts.map((alert) => (
                  <div className="alert-item" key={alert.id}>
                    <span>•</span>
                    <span>{alert.text}</span>
                  </div>
                ))
              ) : (
                <div className="person-sub">No new alerts</div>
              )}
              {appError ? <p className="error-text">{appError}</p> : null}
            </>
          ) : null}
        </div>
      </aside>
    </main>
  );
}
