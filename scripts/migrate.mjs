import {migrateDatabase} from '../lib/migrations.ts';
import {databaseErrorCode} from '../lib/postgres.ts';

try{await migrateDatabase();console.log('Focus Postgres migrations complete.');}
catch(e){const code=databaseErrorCode(e);console.error(code ? 'Database migration failed ('+code+'). Check the connection and migration configuration.' : e.message);process.exitCode=1;}
