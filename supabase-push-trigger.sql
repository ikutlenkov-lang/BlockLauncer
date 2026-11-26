-- BLOCK push delivery: PostgreSQL trigger -> pg_net -> smart-processor
-- Before testing, add a secret in Supabase Vault:
--   name: block_push_webhook_secret
--   value: exactly the same value as Edge Function secret PUSH_WEBHOOK_SECRET
-- Do not put the secret value in this file or commit it to GitHub.

create schema if not exists extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function public.block_send_message_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  push_secret text;
begin
  select decrypted_secret
    into push_secret
  from vault.decrypted_secrets
  where name = 'block_push_webhook_secret'
  limit 1;

  -- Never block message delivery if the Vault secret has not been configured.
  if push_secret is null or length(push_secret) = 0 then
    raise warning 'BLOCK push: Vault secret block_push_webhook_secret is missing; message saved without push';
    return new;
  end if;

  perform net.http_post(
    url := 'https://bohnivogyrohzbawyxpe.supabase.co/functions/v1/smart-processor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || push_secret
    ),
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', null
    )
  );

  return new;
end;
$$;

drop trigger if exists block_message_push_after_insert on public.messages;

create trigger block_message_push_after_insert
after insert on public.messages
for each row
execute function public.block_send_message_push();
