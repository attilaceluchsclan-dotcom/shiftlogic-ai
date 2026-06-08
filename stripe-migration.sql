-- ShiftLogic AI — Stripe Integration Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Adds Stripe billing columns to the profiles table.

-- Add Stripe columns to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Index for fast webhook lookups by Stripe customer ID
CREATE INDEX IF NOT EXISTS profiles_stripe_customer_idx
  ON profiles(stripe_customer_id);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'profiles'
ORDER BY ordinal_position;
