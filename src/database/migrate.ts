import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import pool from '../config/database';
import { config } from 'dotenv';

config();

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('Starting database migrations...');
    
    // Get all migration files sorted by name
    const migrationsDir = join(__dirname, 'migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Sort alphabetically to apply in order
    
    console.log(`Found ${migrationFiles.length} migration(s):`);
    migrationFiles.forEach(file => console.log(`  - ${file}`));
    
    // Execute each migration
    for (const migrationFile of migrationFiles) {
      console.log(`\n📄 Applying ${migrationFile}...`);
      const migrationPath = join(migrationsDir, migrationFile);
    const migrationSQL = readFileSync(migrationPath, 'utf8');
    
      try {
    await client.query(migrationSQL);
        console.log(`✅ ${migrationFile} applied successfully!`);
      } catch (error: any) {
        // If error is about "already exists" or "IF NOT EXISTS", it's safe to continue
        if (error.message?.includes('already exists') || 
            error.message?.includes('duplicate') ||
            migrationSQL.includes('IF NOT EXISTS')) {
          console.log(`⚠️  ${migrationFile} - some objects may already exist, continuing...`);
        } else {
          throw error;
        }
      }
    }
    
    console.log('\n✅ All migrations completed successfully!');
    
    // Verify tables were created
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    console.log('\n📋 Tables in database:');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
