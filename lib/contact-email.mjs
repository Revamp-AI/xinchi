import addresses from 'email-addresses';
import {all} from './db.mjs';

export function emailAddress(input){
 const parsed=addresses.parseOneAddress(String(input||'').trim());
 return parsed?.type==='mailbox'?parsed.address.toLowerCase():'';
}
// Exact mailbox matching only: dots and +tags are meaningful and stay intact.
const shared=/^(no-?reply|do-?not-?reply|notifications?|support|info|hello|team|billing|newsletter|sales|admin|contact|help|office|accounts?|calendar)([.+_-]|@)/i;
export function personalEmail(input){const email=emailAddress(input);return email&&!shared.test(email)?email:'';}
export async function exactEmailContacts(input){
 const email=personalEmail(input);if(!email)return[];
 return all("SELECT c.* FROM contacts c WHERE c.merged_into IS NULL AND c.id IN (SELECT id FROM contacts WHERE merged_into IS NULL AND email<>'' AND lower(btrim(email))=? UNION SELECT contact_id FROM contact_identities WHERE address<>'' AND lower(btrim(address))=?) ORDER BY c.created_at,c.id",email,email);
}
export function combinedNotes(...values){return [...new Set(values.map(v=>String(v||'').trim()).filter(Boolean))].join('\n\n');}
