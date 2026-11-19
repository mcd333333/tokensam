begin;

-- RootData project metadata and two-week financial summaries are stored separately
-- from short-lived raw provider payloads so the one-time profile pull persists.
create table public.rootdata_project_profiles (
  token_id text primary key,
  chain_id text not null,
  rootdata_project_id bigint not null unique check (rootdata_project_id > 0),
  rootdata_project_name text not null,
  token_symbol text,
  rootdata_url text,
  logo_url text,
  establishment_date text,
  tags jsonb not null default '[]'::jsonb,
  one_liner text,
  description text,
  website_url text,
  social_media jsonb not null default '{}'::jsonb,
  total_funding numeric,
  investors jsonb not null default '[]'::jsonb,
  static_collected_at timestamptz not null default now(),
  financial_collected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (token_id, chain_id)
    references public.tokens(id, chain_id)
    on update cascade on delete cascade
);

create index rootdata_profiles_financial_refresh_idx
  on public.rootdata_project_profiles (financial_collected_at asc, token_id);

alter table public.rootdata_project_profiles enable row level security;
revoke all on table public.rootdata_project_profiles from anon, authenticated;
grant select, insert, update, delete on table public.rootdata_project_profiles to service_role;

comment on table public.rootdata_project_profiles is
  'RootData project profiles. Static descriptive/social fields are imported once; total_funding and investors refresh every 14 days.';
comment on column public.rootdata_project_profiles.rootdata_url is
  'Attribution link to the corresponding RootData project profile.';
comment on column public.rootdata_project_profiles.total_funding is
  'RootData Basic-plan aggregate funding total; detailed financing rounds require Plus or Pro.';

commit;
