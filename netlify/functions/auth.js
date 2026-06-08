// ShiftLogic AI — Auth Function
// Handles signup and login via Supabase Auth REST API.
// No npm packages required — uses native fetch (Node 18+).
//
// Required env vars:
//   SUPABASE_URL          e.g. https://xyzxyz.supabase.co
//   SUPABASE_ANON_KEY     from Supabase dashboard → Project Settings → API
//   SUPABASE_SERVICE_KEY  from Supabase dashboard → Project Settings → API (service_role)

exports.handler = async function(event) {
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if(event.httpMethod !== 'POST'){
    return errRes(405, 'Method Not Allowed');
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY){
    console.error('Missing Supabase environment variables');
    return errRes(500, 'Server configuration error.');
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return errRes(400, 'Invalid JSON body.'); }

  if(body.action === 'signup')          return handleSignup(body, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY);
  if(body.action === 'login')           return handleLogin(body, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY);
  if(body.action === 'forgot-password') return handleForgotPassword(body, SUPABASE_URL, SUPABASE_ANON_KEY);
  if(body.action === 'reset-password')  return handleResetPassword(body, SUPABASE_URL, SUPABASE_ANON_KEY);

  return errRes(400, 'Invalid action.');
};

// ─────────────────────────────────────────────────────────
// SIGNUP
// ─────────────────────────────────────────────────────────
async function handleSignup(body, url, anonKey, serviceKey){
  const { name, email, password } = body;

  if(!name || !email || !password) return errRes(400, 'Please provide name, email, and password.');
  if(password.length < 6)          return errRes(400, 'Password must be at least 6 characters.');
  if(!email.includes('@'))         return errRes(400, 'Please provide a valid email address.');

  // 1. Create user in Supabase Auth
  const authRes = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey
    },
    body: JSON.stringify({ email, password, data: { name: name.trim() } })
  });

  const authData = await authRes.json();

  if(!authRes.ok || authData.error){
    const msg = authData.error?.message || authData.msg || 'Signup failed.';
    // Supabase returns 400 for "User already registered"
    return errRes(400, msg);
  }

  const userId      = authData.user?.id;
  const accessToken = authData.access_token;

  if(!userId || !accessToken){
    // Supabase may require email confirmation — access_token is absent
    // In that case, tell the user to check their email
    if(authData.user?.id && !authData.access_token){
      return okRes({
        requiresConfirmation: true,
        message: 'Account created. Please check your email to confirm your address before logging in.'
      });
    }
    return errRes(500, 'Unexpected auth response. Please try again.');
  }

  // 2. Create profile record (name, plan, usage counter)
  const profileRes = await fetch(`${url}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      id: userId,
      name: name.trim(),
      plan: 'free',
      reports_used: 0
    })
  });

  if(!profileRes.ok){
    // Non-fatal — user is created, profile may already exist or will be created on first login
    console.warn('Profile insert failed:', await profileRes.text());
  }

  return okRes({
    token: accessToken,
    user: {
      id: userId,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      plan: 'free',
      reportsUsed: 0
    }
  });
}

// ─────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────
async function handleLogin(body, url, anonKey, serviceKey){
  const { email, password } = body;
  if(!email || !password) return errRes(400, 'Please provide email and password.');

  // 1. Sign in with Supabase Auth
  const authRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey
    },
    body: JSON.stringify({ email, password })
  });

  const authData = await authRes.json();

  if(!authRes.ok || authData.error){
    // Don't leak whether the email exists
    return errRes(401, 'Invalid email or password.');
  }

  const accessToken = authData.access_token;
  const userId      = authData.user?.id;

  if(!accessToken || !userId) return errRes(500, 'Login failed. Please try again.');

  // 2. Fetch profile
  const profileRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${userId}&select=name,plan,reports_used`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    }
  );

  const profiles = await profileRes.json();
  const profile   = Array.isArray(profiles) && profiles[0]
    ? profiles[0]
    : { name: email, plan: 'free', reports_used: 0 };

  return okRes({
    token: accessToken,
    user: {
      id: userId,
      name: profile.name,
      email: authData.user.email,
      plan: profile.plan || 'free',
      reportsUsed: profile.reports_used || 0
    }
  });
}

// ─────────────────────────────────────────────────────────
// FORGOT PASSWORD
// ─────────────────────────────────────────────────────────
async function handleForgotPassword(body, url, anonKey){
  const { email } = body;
  if(!email) return errRes(400, 'Please provide an email address.');

  // Call Supabase recovery endpoint — always return success to avoid email enumeration
  await fetch(`${url}/auth/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
    body: JSON.stringify({ email })
  });

  return okRes({ message: 'If an account exists for that email, a password reset link has been sent.' });
}

// ─────────────────────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────────────────────
async function handleResetPassword(body, url, anonKey){
  const { access_token, password } = body;
  if(!access_token) return errRes(400, 'Missing reset token. Please use the link from your email.');
  if(!password || password.length < 6) return errRes(400, 'Password must be at least 6 characters.');

  const res  = await fetch(`${url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${access_token}`
    },
    body: JSON.stringify({ password })
  });

  const data = await res.json();

  if(!res.ok || data.error){
    const msg = data.error?.message || 'Password reset failed. The link may have expired — please request a new one.';
    return errRes(400, msg);
  }

  return okRes({ message: 'Password updated. You can now log in with your new password.' });
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function okRes(data){
  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, ...data })
  };
}

function errRes(status, message){
  return {
    statusCode: status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  };
}

function cors(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
