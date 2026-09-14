import {migrateDatabase} from '../../lib/migrations.mjs';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {after} from 'node:test';
import {closeDatabase} from '../../lib/postgres.mjs';

export async function setupTestDatabase(){
 const url=new URL(process.env.FOCUS_TEST_DATABASE_URL||'postgresql://127.0.0.1:55439/postgres');
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Tests require an isolated local Postgres server; FOCUS_TEST_DATABASE_URL must be loopback.');
 const name='focus_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:url.href});await admin.connect();
 await admin.query('CREATE DATABASE '+name);
 url.pathname='/'+name;process.env.DATABASE_URL=url.href;delete process.env.DATABASE_URL_UNPOOLED;
 await migrateDatabase(url.href);
 after(async()=>{await closeDatabase();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();});
 return url.href;
}
