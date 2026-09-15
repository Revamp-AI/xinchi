DROP INDEX sync_single_active;
CREATE UNIQUE INDEX sync_provider_active ON sync_runs(provider)
 WHERE state IN ('queued','running','uploading');
