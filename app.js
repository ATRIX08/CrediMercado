const STORAGE_KEY = "credimercado_dados_v1";
const SESSION_KEY = "credimercado_sessao_v1";

const defaultSettings = {
  marketName: "CrediMercado",
  marketPhone: "",
  chargeMessage:
    "Olá, {cliente}. Passando para lembrar que há {valor} em aberto no mercado. Pode verificar para nós?",
  operatorLimit: 0,
  lastBackupAt: "",
};

const initialData = {
  users: [
    {
      id: "admin",
      name: "Administrador",
      username: "admin",
      password: "admin123",
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

let data = loadData();
let currentUser = getCurrentUser();

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

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.users?.length) return migrateData(saved);
  } catch {
    // Comeca limpo quando o armazenamento estiver invalido.
  }

  return migrateData(JSON.parse(JSON.stringify(initialData)));
}

function migrateData(saved) {
  return {
    users: saved.users.map((user) => ({
      active: true,
      lastLoginAt: "",
      ...user,
      role: user.role || "Operador",
    })),
    customers: Array.isArray(saved.customers) ? saved.customers : [],
    settings: { ...defaultSettings, ...(saved.settings || {}) },
    audit: Array.isArray(saved.audit) ? saved.audit : [],
  };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function id() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
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

function getCurrentUser() {
  const userId = sessionStorage.getItem(SESSION_KEY);
  return data.users.find((user) => user.id === userId && user.active !== false) || null;
}

function can(action) {
  return Boolean(permissions[currentUser?.role]?.[action]);
}

function addAudit(action, detail = "") {
  data.audit.unshift({
    id: id(),
    action,
    detail,
    userId: currentUser?.id || "",
    userName: currentUser?.name || "Sistema",
    createdAt: new Date().toISOString(),
  });
  data.audit = data.audit.slice(0, 120);
}

function requireAdminPassword(reason) {
  const password = prompt(`${reason}\n\nDigite a senha de um administrador para confirmar:`);
  if (password === null) return false;
  const ok = data.users.some(
    (user) => user.active !== false && user.role === "Administrador" && user.password === password
  );
  if (!ok) alert("Senha de administrador inválida.");
  return ok;
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
  currentUser = getCurrentUser();
  if (!currentUser) {
    sessionStorage.removeItem(SESSION_KEY);
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
    ? `Ultimo backup exportado em ${dateTimeLabel(data.settings.lastBackupAt)}.`
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

function renderCustomers() {
  const list = document.querySelector("#customerList");
  const customers = getFilteredCustomers();
  const template = document.querySelector("#customerTemplate");

  list.innerHTML = "";
  document.querySelector("#resultCount").textContent =
    customers.length === 1 ? "1 cliente encontrado" : `${customers.length} clientes encontrados`;

  if (!customers.length) {
    list.innerHTML = '<div class="empty">Nenhum cliente para mostrar.</div>';
    return;
  }

  customers.forEach((customer) => {
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
    remove.addEventListener("click", () => {
      if (!can("deleteCustomer")) return;
      if (!confirm(`Excluir ${customer.name} e todo o histórico?`)) return;
      if (!requireAdminPassword("Excluir cliente é uma ação permanente.")) return;
      data.customers = data.customers.filter((item) => item.id !== customer.id);
      addAudit("Cliente excluido", customer.name);
      saveData();
      render();
    });

    list.append(node);
  });
}

function renderDashboardCustomers() {
  const list = document.querySelector("#dashboardCustomerList");
  const customers = data.customers.slice().sort((a, b) => balance(b) - balance(a));
  const template = document.querySelector("#customerTemplate");

  list.innerHTML = "";
  document.querySelector("#dashboardResultCount").textContent =
    customers.length === 1 ? "1 cliente encontrado" : `${customers.length} clientes encontrados`;

  if (!customers.length) {
    list.innerHTML = '<div class="empty">Nenhum cliente para mostrar.</div>';
    return;
  }

  customers.forEach((customer) => {
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
    remove.addEventListener("click", () => {
      if (!can("deleteCustomer")) return;
      if (!confirm(`Excluir ${customer.name} e todo o histórico?`)) return;
      if (!requireAdminPassword("Excluir cliente é uma ação permanente.")) return;
      data.customers = data.customers.filter((item) => item.id !== customer.id);
      addAudit("Cliente excluido", customer.name);
      saveData();
      render();
    });

    list.append(node);
  });
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
  addAudit("Cobrança enviada", customer.name);
  saveData();
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
      userButton(user.active === false ? "Ativar" : "Bloquear", () => toggleUser(user), !can("users") || user.id === currentUser.id),
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

function editUser(user) {
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
  if (data.users.some((item) => item.id !== user.id && normalize(item.username) === normalize(username))) {
    alert("Esse usuário já existe.");
    return;
  }

  user.name = name.trim();
  user.username = normalize(username);
  user.role = role;
  addAudit("Usuário editado", user.name);
  saveData();
  render();
}

function changeUserPassword(user) {
  const password = prompt(`Nova senha para ${user.name}:`);
  if (password === null) return;
  if (password.length < 4) {
    alert("A senha precisa ter pelo menos 4 caracteres.");
    return;
  }
  user.password = password;
  addAudit("Senha alterada", user.name);
  saveData();
  renderUsers();
}

function toggleUser(user) {
  user.active = user.active === false;
  addAudit(user.active ? "Usuário ativado" : "Usuário bloqueado", user.name);
  saveData();
  render();
}

function removeUser(user) {
  if (!confirm(`Remover o usuário ${user.name}?`)) return;
  if (!requireAdminPassword("Remover usuário é uma ação administrativa.")) return;
  data.users = data.users.filter((item) => item.id !== user.id);
  addAudit("Usuário removido", user.name);
  saveData();
  render();
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
      const matchesText =
        !query || normalize(`${item.action} ${item.detail} ${item.userName}`).includes(query);
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

function customerByName(name) {
  return data.customers.find((customer) => normalize(customer.name) === normalize(name));
}

document.querySelector("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const username = normalize(document.querySelector("#loginUsername").value);
  const password = document.querySelector("#loginPassword").value;
  const user = data.users.find((item) => normalize(item.username) === username && item.password === password);

  if (!user || user.active === false) {
    document.querySelector("#loginMessage").textContent = "Usuário bloqueado ou senha inválida.";
    return;
  }

  user.lastLoginAt = new Date().toISOString();
  currentUser = user;
  sessionStorage.setItem(SESSION_KEY, user.id);
  addAudit("Login realizado", user.name);
  saveData();
  document.querySelector("#loginMessage").textContent = "";
  event.target.reset();
  showApp();
});

document.querySelector("#logoutBtn").addEventListener("click", () => {
  addAudit("Logout realizado", currentUser?.name || "");
  saveData();
  sessionStorage.removeItem(SESSION_KEY);
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

document.querySelector("#debtForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!can("debt")) return;
  const amount = Number(document.querySelector("#debtAmount").value);
  const limit = Number(data.settings.operatorLimit || 0);

  if (currentUser.role === "Operador" && limit > 0 && amount > limit) {
    alert(`Seu perfil permite lançamentos de até ${money(limit)}.`);
    return;
  }

  let customer = customerByName(document.querySelector("#customerName").value);

  if (!customer) {
    customer = {
      id: id(),
      name: document.querySelector("#customerName").value.trim(),
      phone: document.querySelector("#customerPhone").value.trim(),
      entries: [],
      createdAt: new Date().toISOString(),
    };
    data.customers.push(customer);
  } else if (document.querySelector("#customerPhone").value.trim()) {
    customer.phone = document.querySelector("#customerPhone").value.trim();
  }

  customer.entries.push({
    id: id(),
    type: "debt",
    amount,
    dueDate: document.querySelector("#dueDate").value,
    note: document.querySelector("#debtNote").value.trim(),
    createdAt: new Date().toISOString(),
    userId: currentUser.id,
  });

  addAudit("Dívida lançada", `${customer.name} - ${money(amount)}`);
  event.target.reset();
  document.querySelector("#dueDate").value = today();
  saveData();
  render();
});

document.querySelector("#paymentForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!can("payment")) return;
  const customer = data.customers.find((item) => item.id === document.querySelector("#paymentCustomer").value);
  const amount = Number(document.querySelector("#paymentAmount").value);

  if (!customer) return;

  customer.entries.push({
    id: id(),
    type: "payment",
    amount,
    date: document.querySelector("#paymentDate").value || today(),
    paymentMethod: document.querySelector("#paymentMethod").value,
    note: document.querySelector("#paymentNote").value.trim(),
    createdAt: new Date().toISOString(),
    userId: currentUser.id,
  });

  addAudit("Pagamento registrado", `${customer.name} - ${money(amount)}`);
  event.target.reset();
  document.querySelector("#paymentDate").value = today();
  saveData();
  render();
});

document.querySelector("#userForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!can("users")) return;
  const username = normalize(document.querySelector("#newUsername").value);

  if (data.users.some((user) => normalize(user.username) === username)) {
    alert("Esse usuário já existe.");
    return;
  }

  const user = {
    id: id(),
    name: document.querySelector("#newUserName").value.trim(),
    username,
    password: document.querySelector("#newUserPassword").value,
    role: document.querySelector("#newUserRole").value,
    active: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: "",
  };

  data.users.push(user);
  addAudit("Usuário cadastrado", user.name);
  event.target.reset();
  saveData();
  render();
});

document.querySelector("#settingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!can("settings")) return;
  data.settings.marketName = document.querySelector("#marketName").value.trim() || "CrediMercado";
  data.settings.marketPhone = document.querySelector("#marketPhone").value.trim();
  data.settings.operatorLimit = Number(document.querySelector("#operatorLimit").value) || 0;
  data.settings.chargeMessage =
    document.querySelector("#chargeMessage").value.trim() || defaultSettings.chargeMessage;
  addAudit("Configurações alteradas", data.settings.marketName);
  saveData();
  render();
});

document.querySelector("#searchInput").addEventListener("input", renderCustomers);
document.querySelector("#statusFilter").addEventListener("change", renderCustomers);
document.querySelector("#auditSearch").addEventListener("input", renderAudit);
document.querySelector("#auditDate").addEventListener("change", renderAudit);

document.querySelector("#exportBtn").addEventListener("click", () => {
  if (!can("backup")) return;
  data.settings.lastBackupAt = new Date().toISOString();
  addAudit("Backup exportado", "Arquivo JSON");
  saveData();
  renderAdminStats();

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `backup-credimercado-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#importInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !can("backup")) return;
  if (!requireAdminPassword("Importar backup vai substituir os dados atuais.")) {
    event.target.value = "";
    return;
  }

  try {
    const imported = migrateData(JSON.parse(await file.text()));
    data = imported;
    currentUser = getCurrentUser();
    if (!currentUser) {
      sessionStorage.removeItem(SESSION_KEY);
      showLogin();
      return;
    }
    addAudit("Backup importado", file.name);
    saveData();
    render();
  } catch {
    alert("Não foi possível importar esse backup.");
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#dueDate").value = today();
document.querySelector("#paymentDate").value = today();
saveData();

if (currentUser) {
  showApp();
} else {
  showLogin();
}
