const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const rootDir = path.join(__dirname, "..");
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "db.json");
const sessions = new Map();

const defaultSettings = {
  marketName: "CrediMercado",
  marketPhone: "",
  chargeMessage:
    "Olá, {cliente}. Passando para lembrar que há {valor} em aberto no mercado. Pode verificar para nós?",
  operatorLimit: 0,
  lastBackupAt: "",
};

const defaultData = {
  users: [
    {
      id: "admin",
      name: "Administrador",
      username: "admin",
      passwordHash: hashPassword("admin123"),
      role: "Administrador",
      active: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: "",
    },
  ],
  customers: [],
  settings: defaultSettings,
  audit: [],
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.includes(":")) return false;
  const [salt, originalHash] = passwordHash.split(":");
  const testHash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(testHash, "hex"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) writeData(clone(defaultData));
}

function readData() {
  ensureDataFile();
  try {
    return migrateData(JSON.parse(fs.readFileSync(dataFile, "utf8")));
  } catch {
    const data = clone(defaultData);
    writeData(data);
    return data;
  }
}

function writeData(data) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function migrateData(data) {
  return {
    users: Array.isArray(data.users) && data.users.length ? data.users.map(migrateUser) : clone(defaultData.users),
    customers: Array.isArray(data.customers) ? data.customers : [],
    settings: { ...defaultSettings, ...(data.settings || {}) },
    audit: Array.isArray(data.audit) ? data.audit : [],
  };
}

function migrateUser(user) {
  return {
    active: true,
    lastLoginAt: "",
    ...user,
    role: user.role || "Operador",
    passwordHash: user.passwordHash || hashPassword(user.password || "admin123"),
    password: undefined,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || "",
  };
}

function addAudit(data, user, action, detail = "") {
  data.audit.unshift({
    id: uid(),
    action,
    detail,
    userId: user?.id || "",
    userName: user?.name || "Sistema",
    createdAt: new Date().toISOString(),
  });
  data.audit = data.audit.slice(0, 200);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("Payload muito grande."));
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
  });
}

function authUser(request, data) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return data.users.find((user) => user.id === session.userId && user.active !== false) || null;
}

function can(user, action) {
  const rules = {
    Administrador: ["all"],
    Operador: ["debt", "payment", "whatsapp"],
    Caixa: ["payment"],
    "Somente leitura": [],
  };
  const allowed = rules[user?.role] || [];
  return allowed.includes("all") || allowed.includes(action);
}

function balance(customer) {
  return customer.entries.reduce((total, entry) => {
    return entry.type === "debt" ? total + Number(entry.amount) : total - Number(entry.amount);
  }, 0);
}

function getOrCreateCustomer(data, name, phone) {
  const key = String(name || "").trim().toLowerCase();
  let customer = data.customers.find((item) => item.name.trim().toLowerCase() === key);
  if (!customer) {
    customer = {
      id: uid(),
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      entries: [],
      createdAt: new Date().toISOString(),
    };
    data.customers.push(customer);
  } else if (String(phone || "").trim()) {
    customer.phone = String(phone || "").trim();
  }
  return customer;
}

async function handleApi(request, response, pathname) {
  const data = readData();

  if (request.method === "POST" && pathname === "/api/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    const user = data.users.find((item) => item.username.toLowerCase() === username);
    if (!user || user.active === false || !verifyPassword(body.password || "", user.passwordHash)) {
      return sendJson(response, 401, { error: "Usuário bloqueado ou senha inválida." });
    }
    user.lastLoginAt = new Date().toISOString();
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + 1000 * 60 * 60 * 8 });
    addAudit(data, user, "Login realizado", user.name);
    writeData(data);
    return sendJson(response, 200, { token, user: publicUser(user) });
  }

  const user = authUser(request, data);
  if (!user) return sendJson(response, 401, { error: "Sessão expirada. Faça login novamente." });

  if (request.method === "GET" && pathname === "/api/me") {
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === "GET" && pathname === "/api/state") {
    return sendJson(response, 200, {
      users: data.users.map(publicUser),
      customers: data.customers,
      settings: data.settings,
      audit: data.audit,
    });
  }

  if (request.method === "POST" && pathname === "/api/debts") {
    if (!can(user, "debt")) return sendJson(response, 403, { error: "Sem permissão para lançar dívida." });
    const body = await readBody(request);
    const amount = Number(body.amount);
    const limit = Number(data.settings.operatorLimit || 0);
    if (!body.customerName || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(response, 400, { error: "Informe cliente e valor válidos." });
    }
    if (user.role === "Operador" && limit > 0 && amount > limit) {
      return sendJson(response, 403, { error: `Seu perfil permite lançamentos de até ${limit}.` });
    }
    const customer = getOrCreateCustomer(data, body.customerName, body.customerPhone);
    customer.entries.push({
      id: uid(),
      type: "debt",
      amount,
      dueDate: body.dueDate || "",
      note: String(body.note || "").trim(),
      createdAt: new Date().toISOString(),
      userId: user.id,
    });
    addAudit(data, user, "Dívida lançada", `${customer.name} - ${amount}`);
    writeData(data);
    return sendJson(response, 201, { customer, balance: balance(customer) });
  }

  if (request.method === "POST" && pathname === "/api/payments") {
    if (!can(user, "payment")) return sendJson(response, 403, { error: "Sem permissão para registrar pagamento." });
    const body = await readBody(request);
    const amount = Number(body.amount);
    const customer = data.customers.find((item) => item.id === body.customerId);
    if (!customer || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(response, 400, { error: "Informe cliente e valor válidos." });
    }
    customer.entries.push({
      id: uid(),
      type: "payment",
      amount,
      date: body.date || new Date().toISOString().slice(0, 10),
      paymentMethod: body.paymentMethod || "Dinheiro",
      note: String(body.note || "").trim(),
      createdAt: new Date().toISOString(),
      userId: user.id,
    });
    addAudit(data, user, "Pagamento registrado", `${customer.name} - ${amount}`);
    writeData(data);
    return sendJson(response, 201, { customer, balance: balance(customer) });
  }

  if (request.method === "POST" && pathname === "/api/users") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para gerenciar usuários." });
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    if (!body.name || username.length < 3 || String(body.password || "").length < 4) {
      return sendJson(response, 400, { error: "Preencha nome, usuário e senha." });
    }
    if (data.users.some((item) => item.username.toLowerCase() === username)) {
      return sendJson(response, 409, { error: "Esse usuário já existe." });
    }
    const newUser = {
      id: uid(),
      name: String(body.name).trim(),
      username,
      passwordHash: hashPassword(body.password),
      role: body.role || "Operador",
      active: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: "",
    };
    data.users.push(newUser);
    addAudit(data, user, "Usuário cadastrado", newUser.name);
    writeData(data);
    return sendJson(response, 201, { user: publicUser(newUser) });
  }

  if (request.method === "PATCH" && pathname.startsWith("/api/users/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para gerenciar usuários." });
    const userId = decodeURIComponent(pathname.replace("/api/users/", ""));
    const target = data.users.find((item) => item.id === userId);
    if (!target) return sendJson(response, 404, { error: "Usuário não encontrado." });
    const body = await readBody(request);
    if (body.name) target.name = String(body.name).trim();
    if (body.username) target.username = String(body.username).trim().toLowerCase();
    if (body.role) target.role = String(body.role);
    if (typeof body.active === "boolean") target.active = body.active;
    if (body.password) target.passwordHash = hashPassword(body.password);
    addAudit(data, user, "Usuário alterado", target.name);
    writeData(data);
    return sendJson(response, 200, { user: publicUser(target) });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/users/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para remover usuários." });
    const userId = decodeURIComponent(pathname.replace("/api/users/", ""));
    if (userId === user.id) return sendJson(response, 400, { error: "Você não pode remover seu próprio usuário." });
    if (data.users.length === 1) return sendJson(response, 400, { error: "Mantenha pelo menos um usuário." });
    const target = data.users.find((item) => item.id === userId);
    data.users = data.users.filter((item) => item.id !== userId);
    addAudit(data, user, "Usuário removido", target?.name || userId);
    writeData(data);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/customers/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para excluir cliente." });
    const customerId = decodeURIComponent(pathname.replace("/api/customers/", ""));
    const customer = data.customers.find((item) => item.id === customerId);
    data.customers = data.customers.filter((item) => item.id !== customerId);
    addAudit(data, user, "Cliente excluído", customer?.name || customerId);
    writeData(data);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "PATCH" && pathname === "/api/settings") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para alterar configurações." });
    const body = await readBody(request);
    data.settings = { ...data.settings, ...body };
    addAudit(data, user, "Configurações alteradas", data.settings.marketName);
    writeData(data);
    return sendJson(response, 200, { settings: data.settings });
  }

  if (request.method === "GET" && pathname === "/api/export") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para exportar backup." });
    data.settings.lastBackupAt = new Date().toISOString();
    addAudit(data, user, "Backup exportado", "Arquivo JSON");
    writeData(data);
    return sendJson(response, 200, data);
  }

  if (request.method === "POST" && pathname === "/api/import") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para importar backup." });
    const imported = migrateData(await readBody(request));
    addAudit(imported, user, "Backup importado", "Arquivo JSON");
    writeData(imported);
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: "Rota não encontrada." });
}

function serveStatic(response, pathname) {
  const requestPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, safePath);
  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Acesso negado");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Arquivo não encontrado");
      return;
    }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain; charset=utf-8" });
    response.end(content);
  });
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url.pathname);
        return;
      }
      serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { error: error.message || "Erro interno." });
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`CrediMercado backend rodando em http://127.0.0.1:${PORT}`);
    console.log("Login inicial: admin / admin123");
  });
