import {migrateDatabase} from '../lib/migrations.mjs';

try{await migrateDatabase();console.log('Focus Postgres migrations complete.');}
catch(e){console.error(e.code ? 'Database migration failed ('+e.code+'). Check the connection and migration configuration.' : e.message);process.exitCode=1;}
