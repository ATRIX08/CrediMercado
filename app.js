const TOKEN_KEY = "credimercado_token_v1";
const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:3000" : "";

const defaultSettings = {
  marketName: "CrediMercado",
  marketPhone: "",
  chargeMessage:
    "Olá, {cliente}. Passando para lembrar que há {valor} em aberto no mercado. Pode verificar para nós?",
  operatorLimit: 0,
  lastBackupAt: "",
};

let data = { users: [], customers: [], settings: defaultSettings, audit: [] };
let currentUser = null;

const money = (value) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);

const permissions = {
  Administrador: {
    debt: true,
    payment: true,
    deleteCustomer: true,
    users: true,
    settings: true,
    backup: true,
    whatsapp: true,
  },
  Operador: {
    debt: true,
    payment: true,
    deleteCustomer: false,
    users: false,
    settings: false,
    backup: false,
    whatsapp: true,
  },
  Caixa: {
    debt: false,
    payment: true,
    deleteCustomer: false,
    users: false,
    settings: false,
    backup: false,
    whatsapp: false,
  },
  "Somente leitura": {
    debt: false,
    payment: false,
    deleteCustomer: false,
    users: false,
    settings: false,
    backup: false,
    whatsapp: false,
  },
};

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error("Backend não está ligado. Rode: cd backend && npm start");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      currentUser = null;
      showLogin();
    }
    throw new Error(body.error || "Erro no servidor.");
  }
  return body;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function dateLabel(date) {
  if (!date) return "Sem vencimento";
  return new Date(`${date}T00:00:00`).toLocaleDateString("pt-BR");
}

function dateTimeLabel(value) {
  if (!value) return "Nunca";
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function can(action) {
  return Boolean(permissions[currentUser?.role]?.[action]);
}

function balance(customer) {
  return customer.entries.reduce((total, entry) => {
    return entry.type === "debt" ? total + Number(entry.amount) : total - Number(entry.amount);
  }, 0);
}

function overdue(customer) {
  if (balance(customer) <= 0) return false;
  return customer.entries.some((entry) => entry.type === "debt" && entry.dueDate && entry.dueDate < today());
}

async function loadState() {
  const state = await api("/api/state");
  data = {
    users: state.users || [],
    customers: state.customers || [],
    settings: { ...defaultSettings, ...(state.settings || {}) },
    audit: state.audit || [],
  };
}

async function restoreSession() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) {
    showLogin();
    return;
  }

  try {
    const result = await api("/api/me");
    currentUser = result.user;
    await loadState();
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.querySelector("#loginScreen").classList.remove("hidden");
  document.querySelector("#appScreen").classList.add("hidden");
}

function showApp() {
  document.querySelector("#loginScreen").classList.add("hidden");
  document.querySelector("#appScreen").classList.remove("hidden");
  document.querySelector("#loggedUser").textContent = `${currentUser.name} - ${currentUser.role}`;
  render();
}

function render() {
  if (!currentUser) {
    showLogin();
    return;
  }

  renderBrand();
  renderAccess();
  renderStats();
  renderPaymentOptions();
  renderCustomers();
  renderDashboardCustomers();
  renderUsers();
  renderAdminStats();
  renderSettings();
  renderAudit();
}

function renderBrand() {
  document.querySelector(".brand strong").textContent = data.settings.marketName || "CrediMercado";
}

function renderAccess() {
  document.querySelector('[data-page="users"]').disabled = !can("users");
  document.querySelector("#debtForm").querySelectorAll("input, button").forEach((element) => {
    element.disabled = !can("debt");
  });
  document.querySelector("#paymentForm").querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = !can("payment");
  });
  document.querySelector("#userForm").querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = !can("users");
  });
  document.querySelector("#settingsForm").querySelectorAll("input, button").forEach((element) => {
    element.disabled = !can("settings");
  });
  document.querySelector("#exportBtn").disabled = !can("backup");
  document.querySelector("#importInput").disabled = !can("backup");
}

function renderStats() {
  const balances = data.customers.map(balance);
  const totalOpen = balances.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const month = today().slice(0, 7);
  const monthPaid = data.customers
    .flatMap((customer) => customer.entries)
    .filter((entry) => entry.type === "payment" && entry.date?.startsWith(month))
    .reduce((sum, entry) => sum + Number(entry.amount), 0);

  document.querySelector("#totalOpen").textContent = money(totalOpen);
  document.querySelector("#debtorsCount").textContent = balances.filter((value) => value > 0).length;
  document.querySelector("#overdueCount").textContent = data.customers.filter(overdue).length;
  document.querySelector("#monthPaid").textContent = money(monthPaid);
}

function renderAdminStats() {
  const month = today().slice(0, 7);
  const monthActions = data.customers
    .flatMap((customer) => customer.entries)
    .filter((entry) => entry.createdAt?.startsWith(month)).length;

  document.querySelector("#activeUsersCount").textContent = data.users.filter((user) => user.active !== false).length;
  document.querySelector("#blockedUsersCount").textContent = data.users.filter((user) => user.active === false).length;
  document.querySelector("#monthActionsCount").textContent = monthActions;
  document.querySelector("#lastBackupLabel").textContent = data.settings.lastBackupAt
    ? dateTimeLabel(data.settings.lastBackupAt)
    : "Nunca";
  document.querySelector("#backupStatus").textContent = data.settings.lastBackupAt
    ? `Último backup exportado em ${dateTimeLabel(data.settings.lastBackupAt)}.`
    : "Nenhum backup exportado ainda.";
}

function renderPaymentOptions() {
  const select = document.querySelector("#paymentCustomer");
  const selected = select.value;
  select.innerHTML = '<option value="">Selecione um cliente</option>';

  data.customers
    .filter((customer) => balance(customer) > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .forEach((customer) => {
      const option = document.createElement("option");
      option.value = customer.id;
      option.textContent = `${customer.name} - ${money(balance(customer))}`;
      select.append(option);
    });

  select.value = selected;
}

function getFilteredCustomers() {
  const query = normalize(document.querySelector("#searchInput").value);
  const status = document.querySelector("#statusFilter").value;

  return data.customers
    .filter((customer) => {
      const customerBalance = balance(customer);
      const queryOk = !query || normalize(`${customer.name} ${customer.phone}`).includes(query);
      const statusOk =
        status === "all" ||
        (status === "open" && customerBalance > 0) ||
        (status === "overdue" && overdue(customer)) ||
        (status === "paid" && customerBalance <= 0);
      return queryOk && statusOk;
    })
    .sort((a, b) => balance(b) - balance(a));
}

function customerCard(customer) {
  const template = document.querySelector("#customerTemplate");
  const node = template.content.firstElementChild.cloneNode(true);
  const customerBalance = balance(customer);

  node.querySelector("h3").textContent = customer.name;
  node.querySelector(".phone").textContent = customer.phone || "Sem telefone";
  node.querySelector(".balance").textContent = money(Math.max(customerBalance, 0));
  node.querySelector(".badges").append(...badges(customer, customerBalance));
  node.querySelector(".entries").append(...entries(customer));

  const whatsapp = node.querySelector(".whatsapp");
  whatsapp.disabled = !can("whatsapp") || !customer.phone || customerBalance <= 0;
  whatsapp.addEventListener("click", () => openWhatsapp(customer, customerBalance));

  const remove = node.querySelector(".danger");
  remove.disabled = !can("deleteCustomer");
  remove.addEventListener("click", async () => {
    if (!can("deleteCustomer")) return;
    if (!confirm(`Excluir ${customer.name} e todo o histórico?`)) return;
    try {
      await api(`/api/customers/${encodeURIComponent(customer.id)}`, { method: "DELETE" });
      await loadState();
      render();
    } catch (error) {
      alert(error.message);
    }
  });

  return node;
}

function renderCustomers() {
  const list = document.querySelector("#customerList");
  const customers = getFilteredCustomers();

  list.innerHTML = "";
  document.querySelector("#resultCount").textContent =
    customers.length === 1 ? "1 cliente encontrado" : `${customers.length} clientes encontrados`;

  if (!customers.length) {
    list.innerHTML = '<div class="empty">Nenhum cliente para mostrar.</div>';
    return;
  }

  customers.forEach((customer) => list.append(customerCard(customer)));
}

function renderDashboardCustomers() {
  const list = document.querySelector("#dashboardCustomerList");
  const customers = data.customers.slice().sort((a, b) => balance(b) - balance(a));

  list.innerHTML = "";
  document.querySelector("#dashboardResultCount").textContent =
    customers.length === 1 ? "1 cliente encontrado" : `${customers.length} clientes encontrados`;

  if (!customers.length) {
    list.innerHTML = '<div class="empty">Nenhum cliente para mostrar.</div>';
    return;
  }

  customers.forEach((customer) => list.append(customerCard(customer)));
}

function badges(customer, customerBalance) {
  const status = document.createElement("span");
  status.className = `badge ${customerBalance <= 0 ? "paid" : overdue(customer) ? "overdue" : ""}`;
  status.textContent = customerBalance <= 0 ? "Quitado" : overdue(customer) ? "Vencido" : "Em aberto";

  const count = document.createElement("span");
  count.className = "badge";
  count.textContent = `${customer.entries.length} lançamento(s)`;

  return [status, count];
}

function entries(customer) {
  return customer.entries
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => {
      const row = document.createElement("div");
      row.className = `entry ${entry.type}`;
      const title = entry.type === "debt" ? "Dívida" : "Pagamento";
      const date = entry.type === "debt" ? dateLabel(entry.dueDate) : dateLabel(entry.date);
      const user = data.users.find((item) => item.id === entry.userId);
      const description =
        entry.type === "payment"
          ? [entry.paymentMethod, entry.note || date, user ? `por ${user.name}` : ""].filter(Boolean).join(" - ")
          : [entry.note || date, user ? `por ${user.name}` : ""].filter(Boolean).join(" - ");

      row.innerHTML = `
        <span>${title}</span>
        <span>${description}</span>
        <strong>${entry.type === "debt" ? "+" : "-"} ${money(entry.amount)}</strong>
      `;

      return row;
    });
}

function openWhatsapp(customer, customerBalance) {
  const phone = customer.phone.replace(/\D/g, "");
  const text = encodeURIComponent(
    data.settings.chargeMessage
      .replaceAll("{cliente}", customer.name)
      .replaceAll("{valor}", money(customerBalance))
      .replaceAll("{mercado}", data.settings.marketName || "mercado")
  );
  window.open(`https://wa.me/55${phone}?text=${text}`, "_blank");
}

function renderUsers() {
  const list = document.querySelector("#usersList");
  list.innerHTML = "";

  data.users.forEach((user) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <div>
        <strong>${user.name}</strong>
        <span>${user.username} - ${user.role} - ${user.active === false ? "Bloqueado" : "Ativo"}</span>
        <span>Último acesso: ${dateTimeLabel(user.lastLoginAt)}</span>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "user-actions";
    actions.append(
      userButton("Editar", () => editUser(user), !can("users")),
      userButton("Senha", () => changeUserPassword(user), !can("users")),
      userButton(
        user.active === false ? "Ativar" : "Bloquear",
        () => toggleUser(user),
        !can("users") || user.id === currentUser.id
      ),
      userButton("Remover", () => removeUser(user), !can("users") || user.id === currentUser.id || data.users.length === 1)
    );

    row.append(actions);
    list.append(row);
  });
}

function userButton(text, action, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

async function editUser(user) {
  const name = prompt("Nome do usuário:", user.name);
  if (name === null || !name.trim()) return;
  const username = prompt("Login do usuário:", user.username);
  if (username === null || !username.trim()) return;
  const role = prompt("Perfil: Administrador, Operador, Caixa ou Somente leitura", user.role);
  if (role === null) return;
  const allowedRoles = Object.keys(permissions);
  if (!allowedRoles.includes(role)) {
    alert("Perfil inválido.");
    return;
  }

  try {
    await api(`/api/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), username: normalize(username), role }),
    });
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function changeUserPassword(user) {
  const password = prompt(`Nova senha para ${user.name}:`);
  if (password === null) return;
  if (password.length < 4) {
    alert("A senha precisa ter pelo menos 4 caracteres.");
    return;
  }

  try {
    await api(`/api/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ password }),
    });
    await loadState();
    renderUsers();
  } catch (error) {
    alert(error.message);
  }
}

async function toggleUser(user) {
  try {
    await api(`/api/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ active: user.active === false }),
    });
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function removeUser(user) {
  if (!confirm(`Remover o usuário ${user.name}?`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
}

function renderSettings() {
  document.querySelector("#marketName").value = data.settings.marketName || "";
  document.querySelector("#marketPhone").value = data.settings.marketPhone || "";
  document.querySelector("#operatorLimit").value = data.settings.operatorLimit || "";
  document.querySelector("#chargeMessage").value = data.settings.chargeMessage || "";
}

function renderAudit() {
  const list = document.querySelector("#auditList");
  list.innerHTML = "";
  const query = normalize(document.querySelector("#auditSearch").value);
  const date = document.querySelector("#auditDate").value;
  const items = data.audit
    .filter((item) => {
      const matchesText = !query || normalize(`${item.action} ${item.detail} ${item.userName}`).includes(query);
      const matchesDate = !date || item.createdAt?.startsWith(date);
      return matchesText && matchesDate;
    })
    .slice(0, 60);

  if (!items.length) {
    list.innerHTML = '<div class="empty">Nenhuma ação encontrada.</div>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.innerHTML = `
      <div>
        <strong>${item.action}</strong>
        <span>${item.detail || "Sem detalhe"}</span>
      </div>
      <span>${item.userName} - ${dateTimeLabel(item.createdAt)}</span>
    `;
    list.append(row);
  });
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = normalize(document.querySelector("#loginUsername").value);
  const password = document.querySelector("#loginPassword").value;

  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    sessionStorage.setItem(TOKEN_KEY, result.token);
    currentUser = result.user;
    document.querySelector("#loginMessage").textContent = "";
    event.target.reset();
    await loadState();
    showApp();
  } catch (error) {
    document.querySelector("#loginMessage").textContent = error.message;
  }
});

document.querySelector("#registerCompanyForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const result = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        marketName: document.querySelector("#registerMarketName").value.trim(),
        marketPhone: document.querySelector("#registerMarketPhone").value.trim(),
        ownerName: document.querySelector("#registerOwnerName").value.trim(),
        username: document.querySelector("#registerUsername").value.trim(),
        password: document.querySelector("#registerPassword").value,
      }),
    });

    sessionStorage.setItem(TOKEN_KEY, result.token);
    currentUser = result.user;
    document.querySelector("#registerMessage").textContent = "";
    event.target.reset();
    await loadState();
    showApp();
  } catch (error) {
    document.querySelector("#registerMessage").textContent = error.message;
  }
});

document.querySelector("#logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  showLogin();
});

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.page === "users" && !can("users")) {
      alert("Seu perfil não tem acesso à área de usuários.");
      return;
    }
    document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    document.querySelector("#dashboardPage").classList.toggle("hidden", button.dataset.page !== "dashboard");
    document.querySelector("#clientsPage").classList.toggle("hidden", button.dataset.page !== "clients");
    document.querySelector("#usersPage").classList.toggle("hidden", button.dataset.page !== "users");
  });
});

document.querySelector("#debtForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!can("debt")) return;

  try {
    await api("/api/debts", {
      method: "POST",
      body: JSON.stringify({
        customerName: document.querySelector("#customerName").value,
        customerPhone: document.querySelector("#customerPhone").value,
        amount: Number(document.querySelector("#debtAmount").value),
        dueDate: document.querySelector("#dueDate").value,
        note: document.querySelector("#debtNote").value.trim(),
      }),
    });
    event.target.reset();
    document.querySelector("#dueDate").value = today();
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#paymentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!can("payment")) return;

  try {
    await api("/api/payments", {
      method: "POST",
      body: JSON.stringify({
        customerId: document.querySelector("#paymentCustomer").value,
        amount: Number(document.querySelector("#paymentAmount").value),
        date: document.querySelector("#paymentDate").value || today(),
        paymentMethod: document.querySelector("#paymentMethod").value,
        note: document.querySelector("#paymentNote").value.trim(),
      }),
    });
    event.target.reset();
    document.querySelector("#paymentDate").value = today();
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!can("users")) return;

  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: document.querySelector("#newUserName").value.trim(),
        username: document.querySelector("#newUsername").value,
        password: document.querySelector("#newUserPassword").value,
        role: document.querySelector("#newUserRole").value,
      }),
    });
    event.target.reset();
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!can("settings")) return;

  try {
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        marketName: document.querySelector("#marketName").value.trim() || "CrediMercado",
        marketPhone: document.querySelector("#marketPhone").value.trim(),
        operatorLimit: Number(document.querySelector("#operatorLimit").value) || 0,
        chargeMessage: document.querySelector("#chargeMessage").value.trim() || defaultSettings.chargeMessage,
      }),
    });
    await loadState();
    render();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#searchInput").addEventListener("input", renderCustomers);
document.querySelector("#statusFilter").addEventListener("change", renderCustomers);
document.querySelector("#auditSearch").addEventListener("input", renderAudit);
document.querySelector("#auditDate").addEventListener("change", renderAudit);

document.querySelector("#exportBtn").addEventListener("click", async () => {
  if (!can("backup")) return;
  try {
    const backup = await api("/api/export");
    await loadState();
    renderAdminStats();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `backup-credimercado-${today()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#importInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !can("backup")) return;

  try {
    const imported = JSON.parse(await file.text());
    await api("/api/import", {
      method: "POST",
      body: JSON.stringify(imported),
    });
    await loadState();
    render();
  } catch {
    alert("Não foi possível importar esse backup.");
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#dueDate").value = today();
document.querySelector("#paymentDate").value = today();
restoreSession();
