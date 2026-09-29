// Edge Function: job-leads-inbox
//
// Lets the "Daily Jobs Report" scheduled routine push new job leads straight
// into this dashboard, instead of the user having to copy them over by hand.
// The routine has no Supabase session (it's a machine caller, not a signed-in
// browser), so it can't use the same "verify via the caller's JWT" pattern the
// google-oauth function uses — instead it authenticates with a single shared
// secret (JOB_LEADS_API_KEY, set via `supabase secrets set`) that never
// leaves this function and the routine's own stored prompt.
//
// This dashboard is single-user, so the target account is a fixed email
// rather than something the caller gets to specify.
//
// Body: { leads: [{ title, company, location, pay, link, fit, whyFit, watchOuts, runDate }, ...] }
// New leads are appended to the dashboard_data row for tab_key
// "dashboard-jobs-leads-inbox", deduped against what's already there by
// link (falling back to title+company+runDate when a lead has no link).

import { createClient } from "jsr:@supabase/supabase-js@2";

const DASHBOARD_USER_EMAIL = "donstaten23@gmail.com";
const TAB_KEY = "dashboard-jobs-leads-inbox";

function leadKey(lead: Record<string, unknown>): string {
  const link = typeof lead.link === "string" ? lead.link.trim() : "";
  if (link) return "link:" + link.toLowerCase();
  return "id:" + [lead.title, lead.company, lead.runDate].map((v) => String(v || "").trim().toLowerCase()).join("|");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  const expectedKey = Deno.env.get("JOB_LEADS_API_KEY");
  const gotKey = req.headers.get("x-api-key");
  if (!expectedKey || gotKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { leads?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) {
    return new Response(JSON.stringify({ ok: true, added: 0, skipped: 0 }), { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: users, error: userErr } = await supabase.auth.admin.listUsers();
  if (userErr) {
    return new Response(JSON.stringify({ error: "user lookup failed: " + userErr.message }), { status: 500 });
  }
  const user = users.users.find((u) => (u.email || "").toLowerCase() === DASHBOARD_USER_EMAIL.toLowerCase());
  if (!user) {
    return new Response(JSON.stringify({ error: "dashboard account not found" }), { status: 500 });
  }

  const { data: row, error: readErr } = await supabase
    .from("dashboard_data")
    .select("data")
    .eq("user_id", user.id)
    .eq("tab_key", TAB_KEY)
    .maybeSingle();
  if (readErr) {
    return new Response(JSON.stringify({ error: "read failed: " + readErr.message }), { status: 500 });
  }

  const existingLeads: Record<string, unknown>[] = (row && row.data && Array.isArray(row.data.leads)) ? row.data.leads : [];
  const seen = new Set(existingLeads.map(leadKey));

  var added = 0;
  var skipped = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") { skipped++; continue; }
    const lead = raw as Record<string, unknown>;
    const key = leadKey(lead);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    existingLeads.push({
      id: crypto.randomUUID(),
      title: String(lead.title || ""),
      company: String(lead.company || ""),
      location: String(lead.location || ""),
      pay: String(lead.pay || ""),
      link: String(lead.link || ""),
      fit: String(lead.fit || ""),
      whyFit: String(lead.whyFit || ""),
      watchOuts: String(lead.watchOuts || ""),
      runDate: String(lead.runDate || ""),
      addedAt: new Date().toISOString(),
    });
    added++;
  }

  if (added > 0) {
    const { error: writeErr } = await supabase
      .from("dashboard_data")
      .upsert({ user_id: user.id, tab_key: TAB_KEY, data: { leads: existingLeads }, updated_at: new Date().toISOString() });
    if (writeErr) {
      return new Response(JSON.stringify({ error: "write failed: " + writeErr.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true, added: added, skipped: skipped }), { status: 200 });
});
