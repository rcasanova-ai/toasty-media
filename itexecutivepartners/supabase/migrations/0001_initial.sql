-- IT Executive Partners - Recruit. Execute ONLY in a NEW independent Supabase project.
-- Minimal tenant-safe recruitment data model; no public policies on candidate records.
create extension if not exists pgcrypto;
create table if not exists public.organizations(
 id uuid primary key default gen_random_uuid(),
 name text not null,
 created_at timestamptz not null default now()
);
create table if not exists public.memberships(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('admin','recruiter','viewer')),
 primary key(organization_id,user_id)
);
create table if not exists public.roles(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 title text not null,
 market text not null check (market in ('Canada','Thailand','Other')),
 description text not null default '',
 status text not null default 'draft' check (status in ('draft','open','paused','closed')),
 created_at timestamptz not null default now(),
 unique(id,organization_id)
);
create table if not exists public.candidates(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 display_name text not null,
 contact_email text,
 consent_status text not null default 'pending' check (consent_status in ('pending','granted','withdrawn')),
 created_at timestamptz not null default now(),
 unique(id,organization_id)
);
create table if not exists public.candidate_evidence(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 candidate_id uuid not null,
 claim text not null,
 provenance text not null,
 approved_by_candidate boolean not null default false,
 created_at timestamptz not null default now(),
 foreign key(candidate_id,organization_id) references public.candidates(id,organization_id) on delete cascade
);
create table if not exists public.applications(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 role_id uuid not null,
 candidate_id uuid not null,
 stage text not null default 'new' check(stage in ('new','review','interview','offer','placed','declined','withdrawn')),
 created_at timestamptz not null default now(),
 foreign key(role_id,organization_id) references public.roles(id,organization_id) on delete cascade,
 foreign key(candidate_id,organization_id) references public.candidates(id,organization_id) on delete cascade,
 unique(organization_id,role_id,candidate_id)
);
create table if not exists public.agent_events(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 actor_user_id uuid references auth.users(id),
 event_kind text not null,
 subject_kind text not null,
 subject_id uuid,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create table if not exists public.onboarding_checkpoints(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 application_id uuid not null,
 day_number int not null check(day_number between 1 and 100),
 description text not null,
 completed_at timestamptz,
 foreign key(application_id,organization_id) references public.applications(id,organization_id) on delete cascade
);
create or replace function public.can_read_recruit_org(org_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.organization_id=org_id and m.user_id=(select auth.uid()))
$$;
create or replace function public.can_write_recruit_org(org_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.organization_id=org_id and m.user_id=(select auth.uid()) and m.role in ('admin','recruiter'))
$$;
revoke all on function public.can_read_recruit_org(uuid) from public;
revoke all on function public.can_write_recruit_org(uuid) from public;
grant execute on function public.can_read_recruit_org(uuid) to authenticated;
grant execute on function public.can_write_recruit_org(uuid) to authenticated;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.roles enable row level security;
alter table public.candidates enable row level security;
alter table public.candidate_evidence enable row level security;
alter table public.applications enable row level security;
alter table public.agent_events enable row level security;
alter table public.onboarding_checkpoints enable row level security;
create policy "org read" on public.organizations for select to authenticated using(public.can_read_recruit_org(id));
create policy "membership self read" on public.memberships for select to authenticated using(user_id=(select auth.uid()));
-- Membership creation is privileged server-side only, never self-serve.
create policy "roles read" on public.roles for select to authenticated using(public.can_read_recruit_org(organization_id));
create policy "roles write" on public.roles for all to authenticated using(public.can_write_recruit_org(organization_id)) with check(public.can_write_recruit_org(organization_id));
create policy "candidates read" on public.candidates for select to authenticated using(public.can_read_recruit_org(organization_id));
create policy "candidates write" on public.candidates for all to authenticated using(public.can_write_recruit_org(organization_id)) with check(public.can_write_recruit_org(organization_id));
create policy "evidence read" on public.candidate_evidence for select to authenticated using(public.can_read_recruit_org(organization_id));
create policy "evidence write" on public.candidate_evidence for all to authenticated using(public.can_write_recruit_org(organization_id)) with check(public.can_write_recruit_org(organization_id));
create policy "applications read" on public.applications for select to authenticated using(public.can_read_recruit_org(organization_id));
create policy "applications write" on public.applications for all to authenticated using(public.can_write_recruit_org(organization_id)) with check(public.can_write_recruit_org(organization_id));
create policy "agent events read" on public.agent_events for select to authenticated using(public.can_read_recruit_org(organization_id));
-- Agent events written only by audited server-side process (no browser insert).
create policy "onboarding read" on public.onboarding_checkpoints for select to authenticated using(public.can_read_recruit_org(organization_id));
create policy "onboarding write" on public.onboarding_checkpoints for all to authenticated using(public.can_write_recruit_org(organization_id)) with check(public.can_write_recruit_org(organization_id));
