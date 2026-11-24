-- BLOCK: групповые чаты
-- Выполни весь файл один раз в Supabase -> SQL Editor -> New query -> Run.

create table if not exists public.block_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 48),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.block_group_members (
  group_id uuid not null references public.block_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.block_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.block_groups(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 3000),
  created_at timestamptz not null default now()
);

create index if not exists block_group_messages_group_created_idx
  on public.block_group_messages(group_id, created_at);

alter table public.block_groups enable row level security;
alter table public.block_group_members enable row level security;
alter table public.block_group_messages enable row level security;

create or replace function public.block_is_group_member(p_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.block_group_members m
    where m.group_id = p_group_id and m.user_id = auth.uid()
  );
$$;
revoke all on function public.block_is_group_member(uuid) from public;
grant execute on function public.block_is_group_member(uuid) to authenticated;


drop policy if exists "Members can view their groups" on public.block_groups;
create policy "Members can view their groups" on public.block_groups
  for select to authenticated
  using (public.block_is_group_member(block_groups.id));

drop policy if exists "Group members can view memberships" on public.block_group_members;
create policy "Group members can view memberships" on public.block_group_members
  for select to authenticated
  using (public.block_is_group_member(block_group_members.group_id));

drop policy if exists "Group members can read messages" on public.block_group_messages;
create policy "Group members can read messages" on public.block_group_messages
  for select to authenticated
  using (public.block_is_group_member(block_group_messages.group_id));

drop policy if exists "Members can send messages as themselves" on public.block_group_messages;
create policy "Members can send messages as themselves" on public.block_group_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.block_group_members m
      where m.group_id = block_group_messages.group_id and m.user_id = auth.uid()
    )
  );

create or replace function public.block_my_groups()
returns table(group_id uuid, group_name text, role text, created_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select g.id, g.name, m.role, g.created_at
  from public.block_groups g
  join public.block_group_members m on m.group_id = g.id
  where m.user_id = auth.uid()
  order by g.created_at desc;
$$;

create or replace function public.block_create_group(p_name text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group_id uuid;
  clean_name text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Нужно войти в BLOCK';
  end if;
  if char_length(clean_name) < 2 or char_length(clean_name) > 48 then
    raise exception 'Название группы должно быть от 2 до 48 символов';
  end if;
  if coalesce(array_length(p_member_ids, 1), 0) < 1 then
    raise exception 'Выбери хотя бы одного участника';
  end if;
  if array_length(p_member_ids, 1) > 50 then
    raise exception 'В одной группе может быть не больше 50 приглашённых';
  end if;

  insert into public.block_groups(name, created_by)
  values (clean_name, auth.uid())
  returning id into new_group_id;

  insert into public.block_group_members(group_id, user_id, role)
  values (new_group_id, auth.uid(), 'owner');

  insert into public.block_group_members(group_id, user_id, role)
  select new_group_id, p.id, 'member'
  from public.profiles p
  where p.id = any(coalesce(p_member_ids, '{}'::uuid[]))
    and p.id <> auth.uid()
  on conflict (group_id, user_id) do nothing;

  if (select count(*) from public.block_group_members m
      where m.group_id = new_group_id and m.user_id <> auth.uid()) = 0 then
    raise exception 'Не удалось добавить выбранных участников';
  end if;

  return new_group_id;
end;
$$;

revoke all on function public.block_my_groups() from public;
revoke all on function public.block_create_group(text, uuid[]) from public;
grant execute on function public.block_my_groups() to authenticated;
grant execute on function public.block_create_group(text, uuid[]) to authenticated;

grant select on public.block_groups to authenticated;
grant select on public.block_group_members to authenticated;
grant select, insert on public.block_group_messages to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.block_group_messages;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'Публикация supabase_realtime не найдена. Включи Realtime для block_group_messages в настройках таблицы.';
end $$;
