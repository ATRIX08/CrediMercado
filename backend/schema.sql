create extension if not exists "pgcrypto";

create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  ativo boolean not null default true,
  motivo_bloqueio text,
  bloqueado_em timestamptz,
  criado_em timestamptz not null default now()
);

alter table empresas add column if not exists ativo boolean not null default true;
alter table empresas add column if not exists motivo_bloqueio text;
alter table empresas add column if not exists bloqueado_em timestamptz;

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nome text not null,
  usuario text not null,
  senha_hash text not null,
  perfil text not null default 'Operador',
  ativo boolean not null default true,
  ultimo_acesso timestamptz,
  criado_em timestamptz not null default now(),
  unique (empresa_id, usuario)
);

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nome text not null,
  telefone text,
  criado_em timestamptz not null default now()
);

create table if not exists lancamentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  tipo text not null check (tipo in ('debt', 'payment')),
  valor numeric(12, 2) not null check (valor > 0),
  vencimento date,
  data_pagamento date,
  forma_pagamento text,
  observacao text,
  criado_por uuid references usuarios(id) on delete set null,
  criado_em timestamptz not null default now()
);

create table if not exists configuracoes (
  empresa_id uuid primary key references empresas(id) on delete cascade,
  nome_mercado text not null default 'CrediMercado',
  telefone_mercado text,
  mensagem_cobranca text not null default 'Olá, {cliente}. Passando para lembrar que há {valor} em aberto no mercado. Pode verificar para nós?',
  limite_operador numeric(12, 2) not null default 0,
  ultimo_backup timestamptz
);

create table if not exists auditoria (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  usuario_id uuid references usuarios(id) on delete set null,
  usuario_nome text not null,
  acao text not null,
  detalhe text,
  criado_em timestamptz not null default now()
);

create index if not exists idx_clientes_empresa_nome on clientes (empresa_id, nome);
create index if not exists idx_lancamentos_empresa_cliente on lancamentos (empresa_id, cliente_id);
create index if not exists idx_auditoria_empresa_criado on auditoria (empresa_id, criado_em desc);
