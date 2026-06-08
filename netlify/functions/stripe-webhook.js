// ShiftLogic AI — Stripe Webhook Handler
// Verifies Stripe signatures and handles subscription lifecycle events.
// Updates user plan in Supabase when payment succeeds or subscription ends.
//
// Uses Node's built-in crypto — no npm required.
//
// Required env vars:
//   STRIPE_WEBHOOK_SECRET   — whsec_... from Stripe Dashboard > Webhooks
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Stripe events handled:
//   checkout.session.completed      → plan = 'pro', store stripe_customer_id
//   customer.subscription.deleted   → plan = 'free'
//   invoice.payment_failed          → logged (future: notify user)

const crypto = require('crypto');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return {statusCode:405, body:'Method Not Allowed'};
  }

  const {STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY} = process.env;

  if(!STRIPE_WEBHOOK_SECRET){
    console.error('STRIPE_WEBHOOK_SECRET not set');
    return {statusCode:500, body:'Webhook secret not configured.'};
  }

  // ── Verify Stripe signature ──
  const sigHeader = event.headers['stripe-signature'];
  if(!sigHeader){
    return {statusCode:400, body:'Missing Stripe-Signature header.'};
  }

  const rawBody = event.body;
  if(!verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)){
    console.error('Stripe signature verification failed');
    return {statusCode:400, body:'Invalid webhook signature.'};
  }

  // ── Parse event ──
  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch(e){ return {statusCode:400, body:'Invalid JSON body.'}; }

  const obj  = stripeEvent.data?.object;
  const type = stripeEvent.type;

  console.log('Stripe webhook received:', type);

  try {
    if(type === 'checkout.session.completed'){
      // User completed checkout — upgrade to pro
      const userId     = obj.client_reference_id;
      const customerId = obj.customer;
      if(userId && customerId){
        await updateProfile(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
          match: {id: userId},
          fields: {plan: 'pro', stripe_customer_id: customerId}
        });
        console.log(`Upgraded user ${userId} to pro`);
      }
    }
    else if(type === 'customer.subscription.deleted'){
      // Subscription cancelled — downgrade to free
      const customerId = obj.customer;
      if(customerId){
        await updateProfile(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
          match: {stripe_customer_id: customerId},
          fields: {plan: 'free'}
        });
        console.log(`Downgraded customer ${customerId} to free`);
      }
    }
    else if(type === 'invoice.payment_failed'){
      console.warn('Payment failed for customer:', obj.customer, '— invoice:', obj.id);
      // TODO: send email notification to user
    }
    // All other events are ignored — return 200 to acknowledge receipt
  } catch(err){
    console.error('Webhook handler error:', err.message);
    // Still return 200 so Stripe doesn't retry — log the error for investigation
  }

  return {statusCode:200, body:'OK'};
};

// ─────────────────────────────────────────────────────────
// STRIPE SIGNATURE VERIFICATION
// Uses HMAC-SHA256 — Node built-in crypto only
// ─────────────────────────────────────────────────────────
function verifyStripeSignature(payload, sigHeader, secret){
  try {
    const parts  = sigHeader.split(',');
    const tPart  = parts.find(p => p.startsWith('t='));
    const v1Part = parts.find(p => p.startsWith('v1='));
    if(!tPart || !v1Part) return false;

    const t        = tPart.slice(2);
    const v1       = v1Part.slice(3);
    const signed   = `${t}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(v1,       'hex')
    );
  } catch(e){
    console.error('Signature error:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────
async function updateProfile(url, serviceKey, {match, fields}){
  // Build query string from match
  const qs = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${url}/rest/v1/profiles?${qs}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(fields)
  });
  if(!res.ok){
    const text = await res.text();
    console.error('Supabase update failed:', res.status, text);
  }
}
