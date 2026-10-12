ALTER TABLE proposals ADD COLUMN review_attempted_at TIMESTAMPTZ;
-- Recheck open suggestions under the explicit evidence-completion contract.
UPDATE proposals SET reviewed_at=NULL WHERE status IN ('pending','deferred');
