CREATE INDEX contacts_exact_email ON contacts(lower(btrim(email))) WHERE merged_into IS NULL AND email<>'';
CREATE INDEX contact_identities_exact_email ON contact_identities(lower(btrim(address)),contact_id) WHERE address<>'';
