const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

require("./read-env");

const PORT = Number(process.env.PORT || 3000);
const rootDir = path.join(__dirname, "..");
const sessions = new Map();
const platformSessions = new Map();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL não encontrado. Crie backend/.env usando backend/.env.example.");
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
});

const defaultSettings = {
  marketName: "CrediMercado",
  marketPhone: "",
  chargeMessage:
    "Olá, {cliente}. Passando para lembrar que há {valor} em aberto no mercado. Pode verificar para nós?",
  operatorLimit: 0,
  lastBackupAt: "",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

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

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  });
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

function publicUser(row) {
  return {
    id: row.id,
    name: row.nome,
    username: row.usuario,
    role: row.perfil,
    active: row.ativo !== false,
    createdAt: row.criado_em,
    lastLoginAt: row.ultimo_acesso || "",
  };
}

function settingsFromRow(row) {
  if (!row) return defaultSettings;
  return {
    marketName: row.nome_mercado || "CrediMercado",
    marketPhone: row.telefone_mercado || "",
    chargeMessage: row.mensagem_cobranca || defaultSettings.chargeMessage,
    operatorLimit: Number(row.limite_operador || 0),
    lastBackupAt: row.ultimo_backup || "",
  };
}

function entryFromRow(row) {
  return {
    id: row.id,
    type: row.tipo,
    amount: Number(row.valor),
    dueDate: row.vencimento || "",
    date: row.data_pagamento || "",
    paymentMethod: row.forma_pagamento || "",
    note: row.observacao || "",
    createdAt: row.criado_em,
    userId: row.criado_por || "",
  };
}

function customerFromRow(row) {
  return {
    id: row.id,
    name: row.nome,
    phone: row.telefone || "",
    createdAt: row.criado_em,
    entries: [],
  };
}

function can(user, action) {
  const rules = {
    Administrador: ["all"],
    Operador: ["debt", "payment", "whatsapp"],
    Caixa: ["payment"],
    "Somente leitura": [],
  };
  const allowed = rules[user?.perfil] || [];
  return allowed.includes("all") || allowed.includes(action);
}

async function seedIfEmpty() {
  const result = await db.query("select id from empresas limit 1");
  if (result.rowCount) return;

  const empresa = await db.query("insert into empresas (nome, ativo) values ($1, true) returning id", ["CrediMercado"]);
  const empresaId = empresa.rows[0].id;
  const admin = await db.query(
    `insert into usuarios (empresa_id, nome, usuario, senha_hash, perfil)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [empresaId, "Administrador", "admin", hashPassword("admin123"), "Administrador"]
  );
  await db.query(
    `insert into configuracoes
      (empresa_id, nome_mercado, telefone_mercado, mensagem_cobranca, limite_operador)
     values ($1, $2, $3, $4, $5)`,
    [empresaId, "CrediMercado", "", defaultSettings.chargeMessage, 0]
  );
  await addAudit({ id: admin.rows[0].id, empresa_id: empresaId, nome: "Sistema" }, "Sistema iniciado", "Empresa padrão criada");
}

async function addAudit(user, action, detail = "") {
  await db.query(
    `insert into auditoria (empresa_id, usuario_id, usuario_nome, acao, detalhe)
     values ($1, $2, $3, $4, $5)`,
    [user.empresa_id, user.id || null, user.nome || "Sistema", action, detail]
  );
}

async function authUser(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const result = await db.query(
    `select u.*
     from usuarios u
     join empresas e on e.id = u.empresa_id
     where u.id = $1 and u.ativo = true and e.ativo = true`,
    [session.userId]
  );
  return result.rows[0] || null;
}

function platformAdminConfigured() {
  return Boolean(process.env.PLATFORM_ADMIN_USER && process.env.PLATFORM_ADMIN_PASSWORD);
}

function authPlatformAdmin(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = platformSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    platformSessions.delete(token);
    return null;
  }
  return session;
}

async function loadState(empresaId) {
  const [users, settings, customers, entries, audit] = await Promise.all([
    db.query("select * from usuarios where empresa_id = $1 order by criado_em asc", [empresaId]),
    db.query("select * from configuracoes where empresa_id = $1", [empresaId]),
    db.query("select * from clientes where empresa_id = $1 order by nome asc", [empresaId]),
    db.query("select * from lancamentos where empresa_id = $1 order by criado_em desc", [empresaId]),
    db.query("select * from auditoria where empresa_id = $1 order by criado_em desc limit 200", [empresaId]),
  ]);

  const customerMap = new Map();
  for (const row of customers.rows) {
    const customer = customerFromRow(row);
    customerMap.set(customer.id, customer);
  }
  for (const row of entries.rows) {
    const customer = customerMap.get(row.cliente_id);
    if (customer) customer.entries.push(entryFromRow(row));
  }

  return {
    users: users.rows.map(publicUser),
    customers: Array.from(customerMap.values()),
    settings: settingsFromRow(settings.rows[0]),
    audit: audit.rows.map((row) => ({
      id: row.id,
      action: row.acao,
      detail: row.detalhe || "",
      userId: row.usuario_id || "",
      userName: row.usuario_nome,
      createdAt: row.criado_em,
    })),
  };
}

async function getOrCreateCustomer(user, body) {
  const name = String(body.customerName || "").trim();
  const phone = String(body.customerPhone || "").trim();
  const existing = await db.query(
    "select * from clientes where empresa_id = $1 and lower(nome) = lower($2) limit 1",
    [user.empresa_id, name]
  );
  if (existing.rowCount) {
    if (phone) {
      await db.query("update clientes set telefone = $1 where id = $2", [phone, existing.rows[0].id]);
      existing.rows[0].telefone = phone;
    }
    return existing.rows[0];
  }
  const created = await db.query(
    "insert into clientes (empresa_id, nome, telefone) values ($1, $2, $3) returning *",
    [user.empresa_id, name, phone]
  );
  return created.rows[0];
}

async function createCompanyAccess(body) {
  const marketName = String(body.marketName || "").trim();
  const marketPhone = String(body.marketPhone || "").trim();
  const ownerName = String(body.ownerName || "").trim();
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!marketName || !ownerName || username.length < 3 || password.length < 4) {
    const error = new Error("Preencha mercado, responsavel, usuario e senha.");
    error.statusCode = 400;
    throw error;
  }

  const existingUser = await db.query("select id from usuarios where lower(usuario) = $1 limit 1", [username]);
  if (existingUser.rowCount) {
    const error = new Error("Esse usuario ja esta em uso. Escolha outro login para o mercado.");
    error.statusCode = 409;
    throw error;
  }

  const client = await db.connect();
  try {
    await client.query("begin");
    const empresa = await client.query("insert into empresas (nome, telefone, ativo) values ($1, $2, true) returning *", [
      marketName,
      marketPhone,
    ]);
    const empresaId = empresa.rows[0].id;
    const userResult = await client.query(
      `insert into usuarios (empresa_id, nome, usuario, senha_hash, perfil)
       values ($1, $2, $3, $4, 'Administrador')
       returning *`,
      [empresaId, ownerName, username, hashPassword(password)]
    );
    await client.query(
      `insert into configuracoes
        (empresa_id, nome_mercado, telefone_mercado, mensagem_cobranca, limite_operador)
       values ($1, $2, $3, $4, 0)`,
      [empresaId, marketName, marketPhone, defaultSettings.chargeMessage]
    );
    await client.query(
      `insert into auditoria (empresa_id, usuario_id, usuario_nome, acao, detalhe)
       values ($1, $2, $3, $4, $5)`,
      [empresaId, userResult.rows[0].id, ownerName, "Empresa cadastrada", marketName]
    );
    await client.query("commit");
    return { company: empresa.rows[0], user: publicUser(userResult.rows[0]) };
  } catch (error) {
    await client.query("rollback");
    if (error.code === "23505") {
      error.statusCode = 409;
      error.message = "Esse usuario ja existe.";
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadPlatformCompanies() {
  const result = await db.query(
    `select
       e.id,
       e.nome,
       e.telefone,
       e.ativo,
       e.motivo_bloqueio,
       e.bloqueado_em,
       e.criado_em,
       coalesce(u.total, 0) as usuarios,
       coalesce(c.total, 0) as clientes,
       coalesce(l.total, 0) as lancamentos,
       coalesce(l.saldo, 0) as saldo
     from empresas e
     left join (
       select empresa_id, count(*) as total
       from usuarios
       group by empresa_id
     ) u on u.empresa_id = e.id
     left join (
       select empresa_id, count(*) as total
       from clientes
       group by empresa_id
     ) c on c.empresa_id = e.id
     left join (
       select
         empresa_id,
         count(*) as total,
         sum(case when tipo = 'debt' then valor when tipo = 'payment' then -valor else 0 end) as saldo
       from lancamentos
       group by empresa_id
     ) l on l.empresa_id = e.id
     order by e.criado_em desc`
  );

  return result.rows.map((row) => ({
    id: row.id,
    marketName: row.nome,
    marketPhone: row.telefone || "",
    active: row.ativo !== false,
    blockReason: row.motivo_bloqueio || "",
    blockedAt: row.bloqueado_em || "",
    createdAt: row.criado_em,
    usersCount: Number(row.usuarios || 0),
    customersCount: Number(row.clientes || 0),
    entriesCount: Number(row.lancamentos || 0),
    openBalance: Number(row.saldo || 0),
  }));
}

async function loadPlatformCustomers() {
  const result = await db.query(
    `select
       c.id,
       c.nome,
       c.telefone,
       c.criado_em,
       e.id as empresa_id,
       e.nome as empresa_nome,
       coalesce(l.total, 0) as lancamentos,
       coalesce(l.saldo, 0) as saldo,
       l.ultimo_lancamento,
       l.proximo_vencimento
     from clientes c
     join empresas e on e.id = c.empresa_id
     left join (
       select
         empresa_id,
         cliente_id,
         count(*) as total,
         sum(case when tipo = 'debt' then valor when tipo = 'payment' then -valor else 0 end) as saldo,
         max(criado_em) as ultimo_lancamento,
         min(case when tipo = 'debt' and vencimento >= current_date then vencimento end) as proximo_vencimento
       from lancamentos
       group by empresa_id, cliente_id
     ) l on l.empresa_id = c.empresa_id and l.cliente_id = c.id
     order by e.nome asc, c.nome asc`
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.nome,
    phone: row.telefone || "",
    createdAt: row.criado_em,
    companyId: row.empresa_id,
    companyName: row.empresa_nome,
    entriesCount: Number(row.lancamentos || 0),
    balance: Number(row.saldo || 0),
    lastEntryAt: row.ultimo_lancamento || "",
    nextDueDate: row.proximo_vencimento || "",
  }));
}

async function handleApi(request, response, pathname) {
  if (request.method === "OPTIONS") return sendJson(response, 200, { ok: true });

  await seedIfEmpty();

  if (request.method === "POST" && pathname === "/api/platform/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    if (!platformAdminConfigured()) {
      return sendJson(response, 503, { error: "Admin da plataforma nao configurado no servidor." });
    }
    if (username !== String(process.env.PLATFORM_ADMIN_USER).trim().toLowerCase()) {
      return sendJson(response, 401, { error: "Usuario ou senha invalidos." });
    }
    if (String(body.password || "") !== process.env.PLATFORM_ADMIN_PASSWORD) {
      return sendJson(response, 401, { error: "Usuario ou senha invalidos." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    platformSessions.set(token, { role: "platform-admin", expiresAt: Date.now() + 1000 * 60 * 60 * 8 });
    return sendJson(response, 200, { token, user: { name: "Administrador da plataforma", role: "Dono" } });
  }

  if (pathname.startsWith("/api/platform/")) {
    const platformAdmin = authPlatformAdmin(request);
    if (!platformAdmin) return sendJson(response, 401, { error: "Sessao expirada. Entre novamente." });

    if (request.method === "GET" && pathname === "/api/platform/companies") {
      return sendJson(response, 200, { companies: await loadPlatformCompanies() });
    }

    if (request.method === "GET" && pathname === "/api/platform/customers") {
      return sendJson(response, 200, { customers: await loadPlatformCustomers() });
    }

    if (request.method === "POST" && pathname === "/api/platform/companies") {
      try {
        const created = await createCompanyAccess(await readBody(request));
        return sendJson(response, 201, created);
      } catch (error) {
        return sendJson(response, error.statusCode || 500, { error: error.message || "Erro interno." });
      }
    }

    if (request.method === "PATCH" && pathname.startsWith("/api/platform/companies/")) {
      const companyId = decodeURIComponent(pathname.replace("/api/platform/companies/", ""));
      const body = await readBody(request);
      const active = body.active !== false;
      const reason = String(body.reason || "").trim();
      const result = await db.query(
        `update empresas
         set ativo = $1,
             motivo_bloqueio = case when $1 then null else $2 end,
             bloqueado_em = case when $1 then null else now() end
         where id = $3
         returning id`,
        [active, reason || "Assinatura bloqueada pelo administrador", companyId]
      );
      if (!result.rowCount) return sendJson(response, 404, { error: "Empresa nao encontrada." });
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/platform/companies/")) {
      const companyId = decodeURIComponent(pathname.replace("/api/platform/companies/", ""));
      const result = await db.query("delete from empresas where id = $1 returning nome", [companyId]);
      if (!result.rowCount) return sendJson(response, 404, { error: "Empresa nao encontrada." });
      return sendJson(response, 200, { ok: true, deleted: result.rows[0].nome });
    }

    return sendJson(response, 404, { error: "Rota nao encontrada." });
  }

  if (request.method === "POST" && pathname === "/api/register") {
    return sendJson(response, 403, { error: "Cadastro publico desativado. Solicite acesso ao administrador." });
  }

  if (request.method === "POST" && pathname === "/api/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    const userResult = await db.query(
      `select
         u.*,
         e.ativo as empresa_ativa,
         e.motivo_bloqueio as empresa_motivo_bloqueio
       from usuarios u
       join empresas e on e.id = u.empresa_id
       where lower(u.usuario) = $1 and u.ativo = true
       order by u.criado_em asc
       limit 1`,
      [username]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(body.password || "", user.senha_hash)) {
      return sendJson(response, 401, { error: "Usuário bloqueado ou senha inválida." });
    }
    if (user.empresa_ativa === false) {
      const reason = user.empresa_motivo_bloqueio ? ` Motivo: ${user.empresa_motivo_bloqueio}` : "";
      return sendJson(response, 403, { error: `Conta do mercado bloqueada.${reason}` });
    }
    await db.query("update usuarios set ultimo_acesso = now() where id = $1", [user.id]);
    user.ultimo_acesso = new Date().toISOString();
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, empresaId: user.empresa_id, expiresAt: Date.now() + 1000 * 60 * 60 * 8 });
    await addAudit(user, "Login realizado", user.nome);
    return sendJson(response, 200, { token, user: publicUser(user) });
  }

  const user = await authUser(request);
  if (!user) return sendJson(response, 401, { error: "Sessão expirada. Faça login novamente." });

  if (request.method === "GET" && pathname === "/api/me") {
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === "GET" && pathname === "/api/state") {
    return sendJson(response, 200, await loadState(user.empresa_id));
  }

  if (request.method === "POST" && pathname === "/api/debts") {
    if (!can(user, "debt")) return sendJson(response, 403, { error: "Sem permissão para lançar dívida." });
    const body = await readBody(request);
    const amount = Number(body.amount);
    if (!body.customerName || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(response, 400, { error: "Informe cliente e valor válidos." });
    }
    const settings = await db.query("select limite_operador from configuracoes where empresa_id = $1", [user.empresa_id]);
    const limit = Number(settings.rows[0]?.limite_operador || 0);
    if (user.perfil === "Operador" && limit > 0 && amount > limit) {
      return sendJson(response, 403, { error: `Seu perfil permite lançamentos de até ${limit}.` });
    }
    const customer = await getOrCreateCustomer(user, body);
    await db.query(
      `insert into lancamentos (empresa_id, cliente_id, tipo, valor, vencimento, observacao, criado_por)
       values ($1, $2, 'debt', $3, $4, $5, $6)`,
      [user.empresa_id, customer.id, amount, body.dueDate || null, String(body.note || "").trim(), user.id]
    );
    await addAudit(user, "Dívida lançada", `${customer.nome} - ${amount}`);
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/payments") {
    if (!can(user, "payment")) return sendJson(response, 403, { error: "Sem permissão para registrar pagamento." });
    const body = await readBody(request);
    const amount = Number(body.amount);
    const customer = await db.query("select * from clientes where id = $1 and empresa_id = $2", [
      body.customerId,
      user.empresa_id,
    ]);
    if (!customer.rowCount || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(response, 400, { error: "Informe cliente e valor válidos." });
    }
    await db.query(
      `insert into lancamentos
        (empresa_id, cliente_id, tipo, valor, data_pagamento, forma_pagamento, observacao, criado_por)
       values ($1, $2, 'payment', $3, $4, $5, $6, $7)`,
      [
        user.empresa_id,
        customer.rows[0].id,
        amount,
        body.date || new Date().toISOString().slice(0, 10),
        body.paymentMethod || "Dinheiro",
        String(body.note || "").trim(),
        user.id,
      ]
    );
    await addAudit(user, "Pagamento registrado", `${customer.rows[0].nome} - ${amount}`);
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/users") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para gerenciar usuários." });
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    if (!body.name || username.length < 3 || String(body.password || "").length < 4) {
      return sendJson(response, 400, { error: "Preencha nome, usuário e senha." });
    }
    try {
      await db.query(
        `insert into usuarios (empresa_id, nome, usuario, senha_hash, perfil)
         values ($1, $2, $3, $4, $5)`,
        [user.empresa_id, String(body.name).trim(), username, hashPassword(body.password), body.role || "Operador"]
      );
    } catch (error) {
      if (error.code === "23505") return sendJson(response, 409, { error: "Esse usuário já existe." });
      throw error;
    }
    await addAudit(user, "Usuário cadastrado", String(body.name).trim());
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "PATCH" && pathname.startsWith("/api/users/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para gerenciar usuários." });
    const userId = decodeURIComponent(pathname.replace("/api/users/", ""));
    const body = await readBody(request);
    const target = await db.query("select * from usuarios where id = $1 and empresa_id = $2", [userId, user.empresa_id]);
    if (!target.rowCount) return sendJson(response, 404, { error: "Usuário não encontrado." });
    const current = target.rows[0];
    await db.query(
      `update usuarios set
        nome = $1,
        usuario = $2,
        perfil = $3,
        ativo = $4,
        senha_hash = $5
       where id = $6 and empresa_id = $7`,
      [
        body.name ? String(body.name).trim() : current.nome,
        body.username ? String(body.username).trim().toLowerCase() : current.usuario,
        body.role || current.perfil,
        typeof body.active === "boolean" ? body.active : current.ativo,
        body.password ? hashPassword(body.password) : current.senha_hash,
        userId,
        user.empresa_id,
      ]
    );
    await addAudit(user, "Usuário alterado", body.name || current.nome);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/users/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para remover usuários." });
    const userId = decodeURIComponent(pathname.replace("/api/users/", ""));
    if (userId === user.id) return sendJson(response, 400, { error: "Você não pode remover seu próprio usuário." });
    const target = await db.query("select * from usuarios where id = $1 and empresa_id = $2", [userId, user.empresa_id]);
    if (!target.rowCount) return sendJson(response, 404, { error: "Usuário não encontrado." });
    await db.query("delete from usuarios where id = $1 and empresa_id = $2", [userId, user.empresa_id]);
    await addAudit(user, "Usuário removido", target.rows[0].nome);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/customers/")) {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para excluir cliente." });
    const customerId = decodeURIComponent(pathname.replace("/api/customers/", ""));
    const target = await db.query("select * from clientes where id = $1 and empresa_id = $2", [customerId, user.empresa_id]);
    await db.query("delete from clientes where id = $1 and empresa_id = $2", [customerId, user.empresa_id]);
    await addAudit(user, "Cliente excluído", target.rows[0]?.nome || customerId);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "PATCH" && pathname === "/api/settings") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para alterar configurações." });
    const body = await readBody(request);
    await db.query(
      `update configuracoes set
        nome_mercado = $1,
        telefone_mercado = $2,
        mensagem_cobranca = $3,
        limite_operador = $4
       where empresa_id = $5`,
      [
        body.marketName || "CrediMercado",
        body.marketPhone || "",
        body.chargeMessage || defaultSettings.chargeMessage,
        Number(body.operatorLimit || 0),
        user.empresa_id,
      ]
    );
    await db.query("update empresas set nome = $1, telefone = $2 where id = $3", [
      body.marketName || "CrediMercado",
      body.marketPhone || "",
      user.empresa_id,
    ]);
    await addAudit(user, "Configurações alteradas", body.marketName || "CrediMercado");
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && pathname === "/api/export") {
    if (!can(user, "all")) return sendJson(response, 403, { error: "Sem permissão para exportar backup." });
    await db.query("update configuracoes set ultimo_backup = now() where empresa_id = $1", [user.empresa_id]);
    await addAudit(user, "Backup exportado", "Arquivo JSON");
    return sendJson(response, 200, await loadState(user.empresa_id));
  }

  if (request.method === "POST" && pathname === "/api/import") {
    return sendJson(response, 501, { error: "Importação para PostgreSQL ainda não está habilitada." });
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
  .listen(PORT, () => {
    console.log(`CrediMercado rodando em 0.0.0.0:${PORT}`);
    console.log("Login inicial: admin / admin123");
  });
