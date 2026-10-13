import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {run,stamp} from '../lib/db.ts';
import {ownerSuggestions} from '../lib/contacts.ts';

test('owner suggestions merge contacts, commitment and priority owners, sorted case-insensitively',async()=>{
 const t=stamp();
 await run("INSERT INTO contacts(id,name,email) VALUES('c1','beth Fictional',''),('c2','Ada Fictional','ada@example.com'),('c3','','blank@example.com')");
 await run("INSERT INTO contacts(id,name,email,archived) VALUES('c4','Archived Fictional','',true)");
 await run("INSERT INTO items(id,title,kind,status,owner,created_at,updated_at) VALUES('i1','Fictional task','action','candidate','Ada Fictional',?,?),('i2','Other task','action','candidate','Carl Fictional',?,?)",t,t,t,t);
 await run("INSERT INTO priorities(id,stack_id,title,owner,position) VALUES('p1','deal-flow','Fictional priority','Dana Fictional',0)");
 assert.deepEqual(await ownerSuggestions(''),{owners:['Ada Fictional','beth Fictional','Carl Fictional','Dana Fictional'],hasMore:false});
 assert.deepEqual(await ownerSuggestions('  ada@  '),{owners:['Ada Fictional'],hasMore:false});
 assert.deepEqual((await ownerSuggestions('archived')).owners,[]);
 for(let n=0;n<55;n++)await run('INSERT INTO contacts(id,name) VALUES(?,?)','bulk'+n,'Bulk Fictional '+String(n).padStart(2,'0'));
 const page=await ownerSuggestions('bulk');assert.equal(page.owners.length,50);assert.equal(page.hasMore,true);assert.equal(page.owners[0],'Bulk Fictional 00');
});
