# ShiftLogic AI — Resume Point
**Date updated:** 2026-06-08

---

## Current State — ALL CORE FEATURES BUILT ✅

**Live URL:** https://shiftlogic-ai.netlify.app
**Custom domain:** amorlure.sk

### Netlify Functions — All Deployed
| Function | Status | Notes |
|----------|--------|-------|
| auth.js | ✅ | signup, login, forgot-password, reset-password |
| classify.js | ✅ | Haiku classification |
| generate.js | ✅ | Sonnet report generation |
| validate.js | ✅ | Fact-check |
| save-report.js | ✅ | DB save + usage count |
| reports.js | ✅ | Fetch history |
| stripe-checkout.js | ✅ | Stripe Checkout session |
| stripe-webhook.js | ✅ | Subscription events |
| share-report.js | ✅ | Generate shareable link |
| view-report.js | ✅ | Public report view |
| admin.js | ✅ | Admin dashboard data |

---

## Actions Required (manual steps you need to do)

### 1. Run SQL migrations in Supabase
Supabase → SQL Editor → run these files in order:
- `stripe-migration.sql` — adds stripe_customer_id to profiles
- `share-migration.sql` — adds share_token to reports

### 2. Set env vars in Netlify
Netlify → Site → Environment variables:

| Variable | Value |
|----------|-------|
| STRIPE_SECRET_KEY | sk_live_... or sk_test_... |
| STRIPE_PRO_PRICE_ID | price_... (from Stripe product) |
| STRIPE_WEBHOOK_SECRET | whsec_... (from Stripe webhook) |
| ADMIN_SECRET | any strong random string |

### 3. Create Stripe webhook
Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://shiftlogic-ai.netlify.app/.netlify/functions/stripe-webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`

### 4. Create Stripe product
- Create "ShiftLogic AI Pro" product at £29/month
- Copy price ID → STRIPE_PRO_PRICE_ID

---

## Architecture

```
index.html (single-file frontend)
  ↓ auth          signup / login / forgot / reset
  ↓ classify      Haiku classifies notes
  ↓ generate      Sonnet generates report
  ↓ validate      Haiku validates facts
  ↓ save-report   saves to Supabase + usage count
  ↓ reports       fetch history
  ↓ stripe-checkout  Stripe Checkout session
  ↓ stripe-webhook   subscription events → update plan
  ↓ share-report     generate share token
  ↓ view-report      public read by token
  ↓ admin            stats + users (ADMIN_SECRET required)
       ↑
  Supabase Auth + PostgreSQL (profiles, reports)
  Stripe billing
```

## Key Credentials
| Item | Value |
|------|-------|
| Netlify site | shiftlogic-ai.netlify.app |
| Netlify token | nfp_xGj4VYRWauTwiP9Mv24YKhXcS42Afi8T405b |
| Netlify site ID | 7e96fe2b-745d-4d1f-b612-d1c69ebb6f32 |
| GitHub repo | https://github.com/attilaceluchsclan-dotcom/shiftlogic-ai |
| Supabase project | tcnpfwlvzwowrsznqjjg.supabase.co |
| Custom domain | amorlure.sk |
| Anthropic key | In ShiftLogic_AI_Credentials.docx |
