import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
  if (!webhookSecret || req.headers.get("authorization") !== `Bearer ${webhookSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("BLOCK_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:block@blocklaunch.com";
  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) {
    return new Response("Push function secrets are incomplete", { status: 500 });
  }

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const message = payload?.record ?? payload?.data?.record ?? payload;
  const receiverId = message?.receiver_id;
  const senderId = message?.sender_id;
  if (!receiverId || !senderId || receiverId === senderId) {
    return new Response("No recipient", { status: 200 });
  }

  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const query = new URLSearchParams({
    select: "endpoint,p256dh,auth",
    user_id: `eq.${receiverId}`
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?${query}`, { headers });
  if (!response.ok) return new Response("Could not load subscriptions", { status: 502 });
  const subscriptions = await response.json();

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const text = String(message.content ?? "").trim();
  const body = text ? (text.length > 140 ? text.slice(0, 137) + "..." : text) :
    (message.attachment_name?.startsWith("voice-message|") ? "🎙 Голосовое сообщение" :
    message.attachment_name ? "📎 " + message.attachment_name : "У тебя новое сообщение");

  const results = await Promise.all((subscriptions ?? []).map(async (sub: any) => {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: "BLOCK",
        body,
        tag: `block-${senderId}`,
        url: "./"
      }));
      return "sent";
    } catch (error) {
      const status = (error as any)?.statusCode;
      if (status === 404 || status === 410) {
        const del = new URLSearchParams({ user_id: `eq.${receiverId}`, endpoint: `eq.${sub.endpoint}` });
        await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?${del}`, {
          method: "DELETE",
          headers: { ...headers, "Prefer": "return=minimal" }
        });
      }
      return "failed";
    }
  }));

  return new Response(JSON.stringify({ ok: true, subscriptions: subscriptions?.length ?? 0, sent: results.filter((x: string) => x === "sent").length }), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
});
