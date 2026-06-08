// ShiftLogic AI — Stripe Checkout Function
// Creates a Stripe Checkout session for the Pro plan subscription.
// No npm required — uses native fetch (Node 18+).
//
// Required env vars:
//   STRIPE_SECRET_KEY     — sk_live_... or sk_test_...
//   STRIPE_PRO_PRICE_ID   — price_... from Stripe Dashboard
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const STRIPE_API = 'https://api.stripe.com/v1';

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors(),body:''};
  if(event.httpMethod !== 'POST') return errRes(405,'Method Not Allowed');

  const {STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID, SUPABASE_URL, SUPABASE_ANON_KEY} = process.env;
  if(!STRIPE_SECRET_KEY)    return errRes(500,'Stripe not configured.');
  if(!STRIPE_PRO_PRICE_ID)  return errRes(500,'Stripe price ID not configured.');

  // ── Auth ──
  const token = extractToken(event.headers);
  if(!token) return errRes(401,'Authentication required.');
  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '');
  if(!user)  return errRes(401,'Session expired. Please log in again.');

  // ── Determine app origin for redirect URLs ──
  const origin = (event.headers.origin || 'https://shiftlogic-ai.netlify.app').replace(/\/+$/,'');

  // ── Build Stripe Checkout session ──
  const params = new URLSearchParams({
    mode:                               'subscription',
    'line_items[0][price]':             STRIPE_PRO_PRICE_ID,
    'line_items[0][quantity]':          '1',
    customer_email:                     user.email,
    client_reference_id:                user.id,
    'subscription_data[metadata][user_id]': user.id,
    success_url:                        `${origin}/?upgraded=true`,
    cancel_url:                         `${origin}/`
  });

  let stripeRes, stripeData;
  try {
    stripeRes  = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type':   'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    stripeData = await stripeRes.json();
  } catch(e){
    console.error('Stripe fetch failed:', e.message);
    return errRes(502,'Could not reach payment provider. Please try again.');
  }

  if(!stripeRes.ok || stripeData.error){
    console.error('Stripe API error:', stripeData.error);
    return errRes(500, stripeData.error?.message || 'Failed to create checkout session.');
  }

  return {
    statusCode: 200,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:true, url: stripeData.url})
  };
};

// ─────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────
async function verifyUser(token, url, anonKey){
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers:{'apikey':anonKey,'Authorization':`Bearer ${token}`}
    });
    if(!res.ok) return null;
    const u = await res.json();
    return u && u.id ? {id:u.id, email:u.email} : null;
  } catch(e){ return null; }
}

function extractToken(headers){
  const auth = headers['authorization'] || headers['Authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function errRes(status, message){
  return {
    statusCode: status,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:false, error:message})
  };
}

function cors(){
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
