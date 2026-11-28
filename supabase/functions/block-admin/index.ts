import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = (Deno.env.get("BLOCK_URL") ?? Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("BLOCK_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const adminPassword = Deno.env.get("BLOCK_ADMIN_PASSWORD") ?? "";
  const authorization = req.headers.get("authorization") ?? "";

  if (!supabaseUrl || !serviceKey || !adminPassword) {
    console.error("BLOCK admin: required secrets are not configured");
    return json({ error: "Административная функция ещё не настроена на сервере. Проверь BLOCK_URL, BLOCK_SERVICE_ROLE_KEY и BLOCK_ADMIN_PASSWORD." }, 500);
  }

  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "Требуется войти в BLOCK." }, 401);
  }

  // Pass the user's JWT explicitly. With persistSession:false, getUser() without
  // a token has no local session to inspect, even if a global header is present.
  const accessToken = authorization.slice("Bearer ".length).trim();
  if (!accessToken) return json({ error: "Сессия BLOCK не найдена. Войди заново." }, 401);

  const userClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(accessToken);

  if (userError || !userData.user) {
    console.error("BLOCK admin: user token validation failed", userError?.message ?? "No user");
    return json({ error: "Сессия недействительна. Войди в BLOCK заново." }, 401);
  }

  let body: { action?: string; password?: string; user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Некорректный запрос." }, 400);
  }

  if (typeof body.password !== "string" || body.password !== adminPassword) {
    return json({ error: "Неверный админ-пароль." }, 403);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.action === "list") {
    const { data, error } = await admin
      .from("profiles")
      .select("id, username")
      .order("username", { ascending: true });

    if (error) {
      console.error("BLOCK admin: profile listing failed", error.message);
      return json({ error: "Не удалось получить список аккаунтов." }, 500);
    }

    return json({ users: data ?? [] });
  }

  if (body.action === "delete") {
    const targetId = body.user_id;
    if (typeof targetId !== "string" || !targetId) return json({ error: "Не выбран аккаунт." }, 400);
    if (targetId === userData.user.id) {
      return json({ error: "Нельзя удалить аккаунт, с которого открыта админ-панель." }, 400);
    }

    const { error } = await admin.auth.admin.deleteUser(targetId, false);
    if (error) {
      console.error("BLOCK admin: account deletion failed", error.message);
      return json({ error: "Не удалось удалить аккаунт. Проверь, существует ли он." }, 500);
    }

    return json({ ok: true, deleted_user_id: targetId });
  }

  return json({ error: "Неизвестное действие." }, 400);
});
