-- Keep Open Play's numeric session hours authoritative and store a friendly
-- 12-hour label for exports, notifications, and older admin clients.
create or replace function public.normalize_open_play_time_label()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_name text;
begin
  if new.session_start is null or new.session_end is null
     or new.session_start < 0 or new.session_end > 24
     or new.session_end <= new.session_start then
    return new;
  end if;

  v_name := btrim(split_part(coalesce(new.time_label, ''), chr(183), 1));
  if v_name = '' then
    v_name := 'Open Play';
  end if;

  new.time_label := v_name || ' ' || chr(183) || ' '
    || to_char(make_time(mod(new.session_start, 24), 0, 0), 'FMHH12:MI AM')
    || ' ' || chr(8211) || ' '
    || to_char(make_time(mod(new.session_end, 24), 0, 0), 'FMHH12:MI AM');
  return new;
end;
$$;

drop trigger if exists normalize_open_play_time_label_trigger
  on public.open_play_registrations;
create trigger normalize_open_play_time_label_trigger
before insert or update of time_label, session_start, session_end
on public.open_play_registrations
for each row execute function public.normalize_open_play_time_label();

-- Normalize already-created registrations as well.
update public.open_play_registrations
set time_label = time_label
where session_start is not null
  and session_end is not null
  and session_start >= 0
  and session_end <= 24
  and session_end > session_start;

revoke all on function public.normalize_open_play_time_label() from public;

