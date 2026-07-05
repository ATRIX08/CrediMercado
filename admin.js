const PLATFORM_TOKEN_KEY = "credimercado_platform_token_v1";
const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:3000" : "";

let companies = [];
let customers = [];

const money = (value) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function dateTimeLabel(value) {
  if (!value) return "Nunca";
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

async function platformApi(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = sessionStorage.getItem(PLATFORM_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error("Backend nao esta respondendo.");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem(PLATFORM_TOKEN_KEY);
      showPlatformLogin();
    }
    throw new Error(body.error || "Erro no servidor.");
  }
  return body;
}

function showPlatformLogin() {
  document.querySelector("#platformLogin").classList.remove("hidden");
  document.querySelector("#platformApp").classList.add("hidden");
}

function showPlatformApp() {
  document.querySelector("#platformLogin").classList.add("hidden");
  document.querySelector("#platformApp").classList.remove("hidden");
}

async function loadCompanies() {
  const result = await platformApi("/api/platform/companies");
  companies = result.companies || [];
}

async function loadCustomers() {
  const result = await platformApi("/api/platform/customers");
  customers = result.customers || [];
}

function filteredCompanies() {
  const query = normalize(document.querySelector("#companySearch").value);
  return companies.filter((company) => {
    return !query || normalize(`${company.marketName} ${company.marketPhone}`).includes(query);
  });
}

function filteredCustomers() {
  const query = normalize(document.querySelector("#platformCustomerSearch").value);
  const status = document.querySelector("#platformCustomerStatus").value;
  return customers
    .filter((customer) => {
      const queryOk =
        !query || normalize(`${customer.name} ${customer.phone} ${customer.companyName}`).includes(query);
      const balance = Number(customer.balance || 0);
      const statusOk = status === "all" || (status === "open" && balance > 0) || (status === "paid" && balance <= 0);
      return queryOk && statusOk;
    })
    .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
}

function renderStats() {
  document.querySelector("#companiesCount").textContent = companies.length;
  document.querySelector("#platformUsersCount").textContent = companies.reduce((sum, item) => sum + item.usersCount, 0);
  document.querySelector("#platformCustomersCount").textContent = companies.reduce(
    (sum, item) => sum + item.customersCount,
    0
  );
  document.querySelector("#platformOpenBalance").textContent = money(
    companies.reduce((sum, item) => sum + Math.max(item.openBalance, 0), 0)
  );
  document.querySelector("#blockedCompaniesCount").textContent = companies.filter((item) => item.active === false).length;
}

function renderCompanies() {
  const list = document.querySelector("#companiesList");
  const items = filteredCompanies();

  list.innerHTML = "";
  document.querySelector("#companiesResultCount").textContent =
    items.length === 1 ? "1 empresa encontrada" : `${items.length} empresas encontradas`;

  if (!items.length) {
    list.innerHTML = '<div class="empty">Nenhuma empresa para mostrar.</div>';
    return;
  }

  items.forEach((company) => {
    const row = document.createElement("article");
    row.className = `company-card ${company.active === false ? "blocked-company" : ""}`;
    row.innerHTML = `
      <div>
        <h3>${company.marketName}</h3>
        <span>${company.marketPhone || "Sem telefone"} - criada em ${dateTimeLabel(company.createdAt)}</span>
        <span>${company.active === false ? `Bloqueada: ${company.blockReason || "Sem motivo informado"}` : "Ativa"}</span>
      </div>
      <div class="company-metrics">
        <span>${company.active === false ? "Bloqueada" : "Ativa"}</span>
        <span>${company.usersCount} usuario(s)</span>
        <span>${company.customersCount} cliente(s)</span>
        <span>${company.entriesCount} lancamento(s)</span>
        <strong>${money(Math.max(company.openBalance, 0))}</strong>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "company-actions";
    const statusButton = document.createElement("button");
    statusButton.type = "button";
    statusButton.className = company.active === false ? "primary" : "danger";
    statusButton.textContent = company.active === false ? "Desbloquear" : "Bloquear";
    statusButton.addEventListener("click", () => toggleCompanyStatus(company));
    actions.append(statusButton);
    row.append(actions);
    list.append(row);
  });
}

async function toggleCompanyStatus(company) {
  const willBlock = company.active !== false;
  let reason = "";
  if (willBlock) {
    reason = prompt("Motivo do bloqueio:", "Falta de pagamento");
    if (reason === null) return;
    if (!reason.trim()) reason = "Assinatura bloqueada pelo administrador";
    if (!confirm(`Bloquear o acesso de ${company.marketName}?`)) return;
  } else if (!confirm(`Desbloquear o acesso de ${company.marketName}?`)) {
    return;
  }

  try {
    await platformApi(`/api/platform/companies/${encodeURIComponent(company.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !willBlock, reason }),
    });
    await Promise.all([loadCompanies(), loadCustomers()]);
    render();
  } catch (error) {
    alert(error.message);
  }
}

function renderCustomers() {
  const list = document.querySelector("#platformCustomersList");
  const items = filteredCustomers();

  list.innerHTML = "";
  document.querySelector("#platformCustomersResultCount").textContent =
    items.length === 1 ? "1 cliente encontrado" : `${items.length} clientes encontrados`;

  if (!items.length) {
    list.innerHTML = '<div class="empty">Nenhum cliente para mostrar.</div>';
    return;
  }

  items.forEach((customer) => {
    const balance = Number(customer.balance || 0);
    const row = document.createElement("article");
    row.className = "platform-customer-card";
    row.innerHTML = `
      <div>
        <h3>${customer.name}</h3>
        <span>${customer.phone || "Sem telefone"} - ${customer.companyName}</span>
      </div>
      <div class="company-metrics">
        <span>${balance > 0 ? "Devendo" : "Quitado"}</span>
        <span>${customer.entriesCount} lancamento(s)</span>
        <span>${customer.nextDueDate ? `Vence ${dateTimeLabel(customer.nextDueDate).split(",")[0]}` : "Sem vencimento"}</span>
        <strong>${money(Math.max(balance, 0))}</strong>
      </div>
    `;
    list.append(row);
  });
}

function render() {
  renderStats();
  renderCompanies();
  renderCustomers();
}

async function restorePlatformSession() {
  if (!sessionStorage.getItem(PLATFORM_TOKEN_KEY)) {
    showPlatformLogin();
    return;
  }

  try {
    await Promise.all([loadCompanies(), loadCustomers()]);
    showPlatformApp();
    render();
  } catch {
    showPlatformLogin();
  }
}

document.querySelector("#platformLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await platformApi("/api/platform/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#platformUsername").value,
        password: document.querySelector("#platformPassword").value,
      }),
    });
    sessionStorage.setItem(PLATFORM_TOKEN_KEY, result.token);
    document.querySelector("#platformLoginMessage").textContent = "";
    event.target.reset();
    await Promise.all([loadCompanies(), loadCustomers()]);
    showPlatformApp();
    render();
  } catch (error) {
    document.querySelector("#platformLoginMessage").textContent = error.message;
  }
});

document.querySelector("#companyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  document.querySelector("#companyMessage").textContent = "";

  try {
    await platformApi("/api/platform/companies", {
      method: "POST",
      body: JSON.stringify({
        marketName: document.querySelector("#companyMarketName").value,
        marketPhone: document.querySelector("#companyMarketPhone").value,
        ownerName: document.querySelector("#companyOwnerName").value,
        username: document.querySelector("#companyUsername").value,
        password: document.querySelector("#companyPassword").value,
      }),
    });
    event.target.reset();
    document.querySelector("#companyMessage").textContent = "Mercado criado com sucesso.";
    await Promise.all([loadCompanies(), loadCustomers()]);
    render();
  } catch (error) {
    document.querySelector("#companyMessage").textContent = error.message;
  }
});

document.querySelector("#platformLogoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem(PLATFORM_TOKEN_KEY);
  companies = [];
  customers = [];
  showPlatformLogin();
});

document.querySelector("#refreshCompaniesBtn").addEventListener("click", async () => {
  try {
    await Promise.all([loadCompanies(), loadCustomers()]);
    render();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#companySearch").addEventListener("input", renderCompanies);
document.querySelector("#platformCustomerSearch").addEventListener("input", renderCustomers);
document.querySelector("#platformCustomerStatus").addEventListener("change", renderCustomers);

document.querySelectorAll("[data-platform-page]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-platform-page]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    document
      .querySelector("#platformCompaniesPage")
      .classList.toggle("hidden", button.dataset.platformPage !== "companies");
    document
      .querySelector("#platformCustomersPage")
      .classList.toggle("hidden", button.dataset.platformPage !== "customers");
  });
});

restorePlatformSession();
