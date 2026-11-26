import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  // Authenticate the database webhook before processing its payload.
  const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
  const authorization = req.headers.get("authorization") ?? "";

  if (!webhookSecret || authorization !== `Bearer ${webhookSecret}`) {
    console.warn("BLOCK push: webhook authorization failed", {
      secretConfigured: Boolean(webhookSecret),
      authorizationHeaderPresent: Boolean(authorization),
    });
    return new Response("Unauthorized", {
      status: 401,
      headers: corsHeaders,
    });
  }

  const supabaseUrl = (Deno.env.get("BLOCK_URL") ?? "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("BLOCK_SERVICE_ROLE_KEY") ?? "";
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:block@blocklaunch.com";

  const missingSecrets = [
    !supabaseUrl ? "BLOCK_URL" : null,
    !serviceKey ? "BLOCK_SERVICE_ROLE_KEY" : null,
    !vapidPublic ? "VAPID_PUBLIC_KEY" : null,
    !vapidPrivate ? "VAPID_PRIVATE_KEY" : null,
  ].filter(Boolean);

  if (missingSecrets.length > 0) {
    console.error("BLOCK push: required function secrets are missing", missingSecrets);
    return jsonResponse({
      error: "Push function secrets are incomplete",
      missing: missingSecrets,
    }, 500);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error("BLOCK push: invalid webhook JSON", String(error));
    return new Response("Invalid JSON", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const message = payload?.record ?? payload?.data?.record ?? payload;
  const receiverId = message?.receiver_id;
  const senderId = message?.sender_id;

  if (!receiverId || !senderId || receiverId === senderId) {
    console.info("BLOCK push: webhook payload has no eligible recipient");
    return jsonResponse({ ok: true, skipped: true, reason: "No recipient" });
  }

  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
  };

  const query = new URLSearchParams({
    select: "endpoint,p256dh,auth",
    user_id: `eq.${receiverId}`,
  });

  let response: Response;
  try {
    response = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?${query}`,
      { headers },
    );
  } catch (error) {
    console.error("BLOCK push: subscription REST request failed before receiving a response", {
      error: String(error),
    });
    return jsonResponse({
      error: "Subscription database request failed",
      details: String(error),
    }, 502);
  }

  if (!response.ok) {
    const errorDetails = await response.text();
    console.error("BLOCK push: subscription REST API returned an error", {
      status: response.status,
      statusText: response.statusText,
      details: errorDetails.slice(0, 2000),
    });

    return jsonResponse({
      error: "Could not load subscriptions",
      database_status: response.status,
      database_status_text: response.statusText,
      details: errorDetails.slice(0, 2000),
    }, 502);
  }

  let subscriptions: any[];
  try {
    subscriptions = await response.json();
    if (!Array.isArray(subscriptions)) {
      throw new Error("Subscription response was not an array");
    }
  } catch (error) {
    console.error("BLOCK push: could not parse subscription response", String(error));
    return jsonResponse({
      error: "Invalid subscription response",
      details: String(error),
    }, 502);
  }

  console.info("BLOCK push: subscriptions loaded", {
    count: subscriptions.length,
  });

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  } catch (error) {
    console.error("BLOCK push: VAPID configuration is invalid", String(error));
    return jsonResponse({
      error: "Invalid VAPID configuration",
      details: String(error),
    }, 500);
  }

  const messageText = String(message.content ?? "").trim();
  const body = messageText
    ? (messageText.length > 140 ? messageText.slice(0, 137) + "..." : messageText)
    : (message.attachment_name?.startsWith("voice-message|")
      ? "🎙 Голосовое сообщение"
      : message.attachment_name
        ? "📎 " + message.attachment_name
        : "У тебя новое сообщение");

  const results = await Promise.all(
    subscriptions.map(async (sub: any) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: "BLOCK",
            body,
            tag: `block-${senderId}`,
            url: "./",
          }),
        );
        return { result: "sent" };
      } catch (error) {
        const status = (error as any)?.statusCode;
        console.error("BLOCK push: provider rejected a notification", {
          status: status ?? null,
          message: String((error as any)?.message ?? error).slice(0, 1000),
        });

        if (status === 404 || status === 410) {
          const del = new URLSearchParams({
            user_id: `eq.${receiverId}`,
            endpoint: `eq.${sub.endpoint}`,
          });

          try {
            const deleteResponse = await fetch(
              `${supabaseUrl}/rest/v1/push_subscriptions?${del}`,
              {
                method: "DELETE",
                headers: { ...headers, Prefer: "return=minimal" },
              },
            );

            if (!deleteResponse.ok) {
              console.error("BLOCK push: failed to delete expired subscription", {
                status: deleteResponse.status,
                details: (await deleteResponse.text()).slice(0, 1000),
              });
            }
          } catch (deleteError) {
            console.error("BLOCK push: expired subscription cleanup failed", String(deleteError));
          }
        }

        return { result: "failed", status: status ?? null };
      }
    }),
  );

  const sent = results.filter((item) => item.result === "sent").length;
  const failed = results.filter((item) => item.result === "failed").length;

  console.info("BLOCK push: delivery attempt finished", {
    subscriptions: subscriptions.length,
    sent,
    failed,
  });

  return jsonResponse({
    ok: true,
    subscriptions: subscriptions.length,
    sent,
    failed,
  });
});
