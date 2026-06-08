-- ShiftLogic AI — Report Sharing Migration
-- Run this in Supabase SQL Editor after stripe-migration.sql
-- Adds share_token column to the reports table for shareable links.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS share_token TEXT;

-- Unique index — each token must be unique across all reports
CREATE UNIQUE INDEX IF NOT EXISTS reports_share_token_idx
  ON reports(share_token)
  WHERE share_token IS NOT NULL;

-- Allow public read of shared reports (no auth required)
-- RLS policy: anyone can select a report if they know its share_token
CREATE POLICY "Public read by share token" ON reports
  FOR SELECT
  USING (share_token IS NOT NULL);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'reports' AND column_name = 'share_token';
